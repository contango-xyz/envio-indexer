import { Instrument, Position, Token, handlerContext } from "generated";
import { Hex, getContract, parseAbi } from "viem";
import { createInstrumentId } from "../ContangoProxy";
import { eventStore } from "../Store";
import { clients } from "../clients";
import { Cache, CacheCategory } from "./cache";
import { decodeTokenId, getOrCreateToken } from "./getTokenDetails";
import { createIdForPosition } from "./ids";
import { ReturnPromiseType } from "./types";
import { contangoAbi } from "../abis";


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

export const getBalancesAtBlock = async (chainId: number, positionId: Hex, blockNumber: number) => {
  const cached = Cache.init({ category: CacheCategory.Balances, chainId })
  const balances = cached.read(`${positionId}-${blockNumber}`)
  if (balances) return balances

  const balancesFromChain = await _getBalancesAtBlock(chainId, positionId, blockNumber)
  cached.add({ [`${positionId}-${blockNumber}`]: balancesFromChain })
  return balancesFromChain
}

const getInstrument = async (chainId: number, positionId: string) => {
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

  const entity: Instrument = {
    id: createInstrumentId({ chainId, instrumentId }),
    chainId,
    instrumentId,
    collateralToken_id: chainInstrument.base,
    debtToken_id: chainInstrument.quote,
    closingOnly: chainInstrument.closingOnly,
  }

  cached.add({ [instrumentId]: entity })

  return entity
}

export const getOrCreateInstrument = async ({ chainId, positionId, context }: { chainId: number; positionId: string; context: handlerContext }) => {
  const instrumentId = positionId.slice(0, 34)

  const storedInstrument = await context.Instrument.get(createInstrumentId({ chainId, instrumentId }))
  if (storedInstrument) return storedInstrument

  const instrument = await getInstrument(chainId, instrumentId)
  context.Instrument.set(instrument)

  return instrument
}

export const getPairForPositionId = async (
  { positionId, context, chainId }: { chainId: number; positionId: string; context: handlerContext }
): Promise<{ collateralToken: Token; debtToken: Token }> => {
  const cached = Cache.init({ category: CacheCategory.TokenPair, chainId: positionId })
  const tokenPair = cached.read(positionId)
  if (tokenPair) return tokenPair

  const instrument = await getOrCreateInstrument({ chainId, positionId, context })

  const [collateralToken, debtToken] = await Promise.all([
    getOrCreateToken({ ...decodeTokenId(instrument.collateralToken_id), context }),
    getOrCreateToken({ ...decodeTokenId(instrument.debtToken_id), context }),
  ])

  if (!collateralToken) throw new Error(`Token not found for ${instrument.collateralToken_id} positionId: ${positionId}`)
  if (!debtToken) throw new Error(`Token not found for ${instrument.debtToken_id} positionId: ${positionId}`)

  cached.add({ [positionId]: { collateralToken, debtToken } })

  return { collateralToken, debtToken }
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

export const setPosition = (
  position: Position,
  { blockNumber, transactionHash, context }: { blockNumber: number; transactionHash: string; context: handlerContext; }
) => {
  eventStore.setCurrentPosition({ position, blockNumber, transactionHash })
  context.Position.set(position)
}
