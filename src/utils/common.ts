import { Instrument, Token, handlerContext } from "generated";
import { Hex, getContract, parseAbi } from "viem";
import { contangoAbi, iAaveOracleAbi, iContangoLensAbi, iPoolAddressesProviderAbi } from "../abis";
import { clients } from "../clients";
import { Cache, CacheCategory } from "./cache";
import { decodeTokenId, getOrCreateToken } from "./getTokenDetails";
import { createIdForPosition } from "./ids";
import { mulDiv } from "./math-helpers";
import { ReturnPromiseType } from "./types";
import { positionIdMapper } from "./mappers";
import { maestroProxy } from "../ERC20";
import { arbitrum, avalanche, base, bsc, gnosis, mainnet, optimism, polygon, scroll } from "viem/chains";

export const lensAbi = parseAbi([
  "struct Balances { uint256 collateral; uint256 debt; }",
  "function balances(bytes32 positionId) external view returns (Balances memory balances_)",
  "struct Prices { uint256 collateral; uint256 debt; uint256 unit; }",
  "function prices(bytes32 positionId) external view returns (Prices memory prices_)",
])

export const lensAddress = '0xe03835Dfae2644F37049c1feF13E8ceD6b1Bb72a'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const _getBalancesAtBlock = async (chainId: number, positionId: Hex, blockNumber: number) => {
  const lensContract = getContract({
    abi: lensAbi,
    address: lensAddress,
    client: clients[chainId]
  })

  try {
    await delay(150) // avoid rate limiting during indexing
    return await lensContract.read.balances([positionId], { blockNumber: BigInt(blockNumber) })
  } catch {
    return { collateral: -1n, debt: -1n }
  }
}

export type Balances = ReturnPromiseType<typeof _getBalancesAtBlock>

export const getBalancesAtBlock = async (chainId: number, positionId: string, blockNumber: number) => {
  const cached = Cache.init({ category: CacheCategory.Balances, chainId })
  const balances = cached.read(`${positionId}-${blockNumber}`)
  if (balances) return balances

  const balancesFromChain = await _getBalancesAtBlock(chainId, positionId as Hex, blockNumber)
  cached.add({ [`${positionId}-${blockNumber}`]: balancesFromChain })
  return balancesFromChain
}

export const createInstrumentId = ({ chainId, instrumentId }: { chainId: number; instrumentId: string; }) => `${chainId}_${instrumentId.slice(0, 34)}`

const getPrices = async ({ chainId, positionId, blockNumber }: { chainId: number; positionId: string; blockNumber: bigint }) => {
  const { symbolHex } = positionIdMapper(positionId)
  const client = clients[chainId]
  const lens = getContract({ abi: iContangoLensAbi, address: lensAddress, client })
  const contango = getContract({ abi: contangoAbi, address: maestroProxy, client })

  try {
    return await lens.read.prices([positionId as Hex], { blockNumber })
  } catch {
    const name = chainId === gnosis.id ? "Spark" : "Aave"
    console.warn(`Lens prices failed, falling back to ${name}Oracle`)

    const poolAddressesProviderAddress = (() => {
      switch (chainId) {
        case avalanche.id:
        case polygon.id:
        case optimism.id:
        case arbitrum.id:
          return '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb'
        case mainnet.id:
          return '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e'
        case base.id:
          return '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D'
        case bsc.id:
          return '0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D'
        case scroll.id:
          return '0x69850D0B276776781C063771b161bd8894BCdD04'
        case gnosis.id:
          return '0xA98DaCB3fC964A6A0d2ce3B77294241585EAbA6d'
        default: {
          throw new Error(`Unsupported chainId: ${chainId}`)
        }
      }
    })()

    const poolAddressesProvider = getContract({
      abi: iPoolAddressesProviderAbi,
      address: poolAddressesProviderAddress,
      client,
    })
    const [instrument, aaveOracleAddress] = await Promise.all([
      contango.read.instrument([symbolHex], { blockNumber }),
      poolAddressesProvider.read.getPriceOracle({ blockNumber }),
    ])

    const aaveOracle = getContract({ abi: iAaveOracleAbi, address: aaveOracleAddress, client })

    const getAssetPrice = async (asset: Hex) => {
      try {
        return await aaveOracle.read.getAssetPrice([asset], { blockNumber })
      } catch {
        console.warn(`Failed to get price for ${asset} at block ${blockNumber} on chain ${chainId}, returning 0n`)
        return 0n
      }
    }

    const [collateral, debt, unit] = await Promise.all([
      getAssetPrice(instrument.base),
      getAssetPrice(instrument.quote),
      aaveOracle.read.BASE_CURRENCY_UNIT({ blockNumber }),
    ])

    return { collateral: collateral, debt: debt, unit: unit }
  }
}

export const getMarkPrice = async ({ chainId, positionId, blockNumber, debtToken }: { debtToken: Token; chainId: number; positionId: string; blockNumber: number }): Promise<bigint> => {
  const cached = Cache.init({ category: CacheCategory.MarkPrice, chainId })
  const id = `${createInstrumentId({ chainId, instrumentId: positionId })}-${blockNumber}`
  const markPrice = cached.read(id)
  if (markPrice) return markPrice

  try {
    const prices = await getPrices({ chainId, positionId, blockNumber: BigInt(blockNumber) })
    const price = mulDiv(prices.collateral, debtToken.unit, prices.debt)
    cached.add({ [id]: price })
    return price
  } catch {
    console.log('Failed to get mark price for positionId: ', positionId)
    return 0n
  }

}

const getInstrument = async ({ chainId, positionId, context }: { chainId: number; positionId: string; context: handlerContext; }) => {
  const instrumentId = positionId.slice(0, 34) as Hex
  const cached = Cache.init({ category: CacheCategory.Instrument, chainId })
  const instrument = cached.read(instrumentId)
  if (instrument) return instrument

  const contangoProxy = getContract({
    abi: contangoAbi,
    address: "0x6Cae28b3D09D8f8Fc74ccD496AC986FC84C0C24E",
    client: clients[chainId]
  })

  const chainInstrument = await contangoProxy.read.instrument([instrumentId])
  const [base, quote] = await Promise.all([
    getOrCreateToken({ address: chainInstrument.base, chainId, context }),
    getOrCreateToken({ address: chainInstrument.quote, chainId, context }),
  ])

  const entity: Instrument = {
    id: createInstrumentId({ chainId, instrumentId }),
    chainId,
    instrumentId,
    collateralToken_id: base.id,
    debtToken_id: quote.id,
    closingOnly: chainInstrument.closingOnly,
  }

  cached.add({ [instrumentId]: entity })

  return entity
}

export const getOrCreateInstrument = async ({ chainId, positionId, context }: { chainId: number; positionId: string; context: handlerContext }) => {
  const storedInstrument = await context.Instrument.get(createInstrumentId({ chainId, instrumentId: positionId }))
  if (storedInstrument) return storedInstrument

  const instrument = await getInstrument({ chainId, positionId, context })
  context.Instrument.set(instrument)

  return instrument
}

export const getPairForPositionId = async (
  { positionId, context, chainId }: { chainId: number; positionId: string; context: handlerContext }
): Promise<{ collateralToken: Token; debtToken: Token; instrument: Instrument }> => {
  const instrument = await getOrCreateInstrument({ chainId, positionId, context })

  try {
    const [collateralToken, debtToken] = await Promise.all([
      getOrCreateToken({ ...decodeTokenId(instrument.collateralToken_id), context }),
      getOrCreateToken({ ...decodeTokenId(instrument.debtToken_id), context }),
    ])
  
    if (!collateralToken) throw new Error(`Token not found for ${instrument.collateralToken_id} positionId: ${positionId}`)
    if (!debtToken) throw new Error(`Token not found for ${instrument.debtToken_id} positionId: ${positionId}`)
  
    return { collateralToken, debtToken, instrument }
  } catch (e) {
    context.log.error(`Error getting pair for positionId: ${positionId} - instrument: ${instrument.id} ${instrument.collateralToken_id} ${instrument.debtToken_id}`)
    throw e
  }
}


export const getPosition = async ({ chainId, positionId, context }: { chainId: number; positionId: string; context: handlerContext }) => {
  const position = await context.Position.get(createIdForPosition({ chainId, positionId }))
  if (!position) throw new Error(`Position not found for ${createIdForPosition({ chainId, positionId })}`)
  return { ...position }
}


export const getPositionSafe = async ({ chainId, positionId, context }: { chainId: number; positionId: string; context: handlerContext }) => {
  try {
    return await getPosition({ chainId, positionId, context })
  } catch {
    return null
  }
}

