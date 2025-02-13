import { Lot, TestHelpers } from 'generated'
import { decodeEventLog, erc20Abi, getAbiItem, Hex, Log, parseAbi, toEventSelector } from 'viem'
import { contangoAbi, iMoneyMarketAbi, positionNftAbi, simpleSpotExecutorAbi, spotExecutorAbi, strategyBuilderAbi, underlyingPositionFactoryAbi } from '../src/abis'
import { clients } from '../src/clients'
import fs from 'fs/promises'
import path from 'path'

const {
  ContangoProxy,
  ERC20,
  IMoneyMarket,
  PositionNFT,
  SimpleSpotExecutor,
  UnderlyingPositionFactory,
  MockDb,
  WETH,
} = TestHelpers

const wethAbi = parseAbi([
  'event Withdrawal(address indexed src, uint wad)',
  'event Deposit(address indexed dst, uint wad)',
])

const abiItems = {
  'NFT': {
    'Transfer': getAbiItem({ abi: positionNftAbi, name: "Transfer" }),
  },
  'ERC20': {
    'Transfer': getAbiItem({ abi: erc20Abi, name: "Transfer" }),
  },
  'WETH': {
    'Withdrawal': getAbiItem({ abi: wethAbi, name: "Withdrawal" }),
    'Deposit': getAbiItem({ abi: wethAbi, name: "Deposit" }),
  },
  'Strategy': {
    'StragegyExecuted': getAbiItem({ abi: strategyBuilderAbi, name: "StragegyExecuted" }),
  },
  'IMoneyMarket': {
    'Withdrawn': getAbiItem({ abi: iMoneyMarketAbi, name: "Withdrawn" }),
    'Borrowed': getAbiItem({ abi: iMoneyMarketAbi, name: "Borrowed" }),
    'Lent': getAbiItem({ abi: iMoneyMarketAbi, name: "Lent" }),
    'Repaid': getAbiItem({ abi: iMoneyMarketAbi, name: "Repaid" }),
  },
  'Contango': {
    'PositionUpserted': getAbiItem({ abi: contangoAbi, name: "PositionUpserted" }),
  },
  'SpotExecutor': {
    'SwapExecuted': getAbiItem({ abi: spotExecutorAbi, name: "SwapExecuted" }),
  },
  'SimpleSpotExecutor': {
    'SwapExecuted': getAbiItem({ abi: simpleSpotExecutorAbi, name: "SwapExecuted" }),
  },
  'UnderlyingPositionFactory': {
    'UnderlyingPositionCreated': getAbiItem({ abi: underlyingPositionFactoryAbi, name: "UnderlyingPositionCreated" }),
  },
}

const getEventSelectors = (contract: keyof typeof abiItems) => {
  return Object.values(abiItems[contract]).map(toEventSelector)
}

const logToEvent = ({ log, from, to, chainId }: { log: Log; from: Hex; to: Hex; chainId: number }) => {
  const data = log.data === "0x" ? undefined : log.data as Hex
      const topics = log.topics as [Hex, ...Hex[]]
      try {
        const abi = (() => {
          // to ensure no signature collisions we do this verbosely

          if (getEventSelectors('WETH').includes(topics[0])) return wethAbi

          if (getEventSelectors('NFT').includes(topics[0]) && log.address.toLowerCase() === '0xc2462f03920d47fc5b9e2c5f0ba5d2ded058fd78') return positionNftAbi

          if (getEventSelectors('ERC20').includes(topics[0])) return erc20Abi

          if (getEventSelectors('Strategy').includes(topics[0])) return strategyBuilderAbi

          if (getEventSelectors('IMoneyMarket').includes(topics[0])) return iMoneyMarketAbi

          if (getEventSelectors('Contango').includes(topics[0])) return contangoAbi

          if (getEventSelectors('SpotExecutor').includes(topics[0])) return spotExecutorAbi

          if (getEventSelectors('SimpleSpotExecutor').includes(topics[0])) return simpleSpotExecutorAbi

          if (getEventSelectors('UnderlyingPositionFactory').includes(topics[0])) return underlyingPositionFactoryAbi

          return null
        })()
        if (!abi) return null
        const event = decodeEventLog({ abi, data, topics })
        return {
          ...event,
          srcAddress: log.address,
          transaction: {
            hash: log.transactionHash as Hex,
            from,
            to,
          },
          logIndex: Number(log.logIndex),
          block: {
            number: Number(log.blockNumber || 0),
            timestamp: Date.now(), // don't use timestamp for anything in indexing 
            hash: log.blockHash as Hex,
          },
          chainId,
        }
      } catch (e) {
        return null
      }
}

const getCacheDir = () => {
  const cacheDir = path.join(process.cwd(), '.cache')
  return cacheDir
}

const getCacheKey = (chainId: number, transactionHash: string) => {
  return path.join(getCacheDir(), `${chainId}_${transactionHash}.json`)
}

const replacer = (_key: string, value: any) => {
  if (typeof value === 'bigint') {
    return value.toString() + 'n'
  }
  return value
}

const reviver = (_key: string, value: any) => {
  if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1))
  }
  return value
}

const getTransactionLogs = async (chainId: number, transactionHash: string): Promise<{ logs: Log[]; from: Hex; to: Hex }> => {
  const cacheKey = getCacheKey(chainId, transactionHash)
  
  try {
    const cached = await fs.readFile(cacheKey, 'utf-8')
    return JSON.parse(cached, reviver)
  } catch (e) {
    // Cache miss, fetch from chain
    const { logs, from, to } = await clients[chainId].getTransactionReceipt({ hash: transactionHash as Hex })

    if (!to) throw new Error(`Transaction ${transactionHash} "to" property not found`)
    
    // Ensure cache directory exists
    await fs.mkdir(getCacheDir(), { recursive: true })
    
    // Save to cache
    await fs.writeFile(cacheKey, JSON.stringify({ logs, from, to }, replacer, 2))
    
    return { logs, from, to }
  }
}

export const processTransaction = async (chainId: number, transactionHash: string, mockDb: ReturnType<typeof MockDb.createMockDb>) => {
  const { logs, from, to } = await getTransactionLogs(chainId, transactionHash)

  for (const log of logs) {
    const event = logToEvent({ log, from, to, chainId })
    if (!event) continue

    switch (event.eventName) {
      case 'Deposit': {
        mockDb = await WETH.Deposit.processEvent({
          event: { ...event, params: event.args },
          mockDb
        })
        break
      }
      case 'Withdrawal': {
        mockDb = await WETH.Withdrawal.processEvent({
          event: { ...event, params: event.args },
          mockDb
        })
        break
      }
      case 'Transfer': {
        if ('value' in event.args) {
          mockDb = await ERC20.Transfer.processEvent({
            event: { ...event, params: event.args },
            mockDb
          })
        } else {
          mockDb = await PositionNFT.Transfer.processEvent({
            event: { ...event, params: event.args },
            mockDb
          })
        }
        break
      }
      case 'PositionUpserted': {
        mockDb = await ContangoProxy.PositionUpserted.processEvent({
          event: {
            ...event,
            params: {
              ...event.args,
              cashflowCcy: BigInt(event.args.cashflowCcy),
              feeCcy: BigInt(event.args.feeCcy),
            },
          },
          mockDb
        })
        break
      }
      case 'Withdrawn': {
        mockDb = await IMoneyMarket.Withdrawn.processEvent({
          event: { ...event, params: event.args },
          mockDb
        })
        break
      }
      case 'Lent': {
        mockDb = await IMoneyMarket.Lent.processEvent({
          event: { ...event, params: event.args },
          mockDb
        })
        break
      }
      case 'Borrowed': {
        mockDb = await IMoneyMarket.Borrowed.processEvent({
          event: { ...event, params: event.args },
          mockDb
        })
        break
      }
      case 'Repaid': {
        mockDb = await IMoneyMarket.Repaid.processEvent({
          event: { ...event, params: event.args },
          mockDb
        })
        break
      }
      case 'SwapExecuted': {
        if ('tokenToSell' in event.args) {
          mockDb = await SimpleSpotExecutor.SwapExecuted.processEvent({
            event: { ...event, params: event.args },
            mockDb
          })
        }
        break
      }
      case 'UnderlyingPositionCreated': {
        mockDb = await UnderlyingPositionFactory.UnderlyingPositionCreated.processEvent({
          event: { ...event, params: event.args },
          mockDb
        })
        break
      }
      default:
        break
    }
  }

  return mockDb
}

const getTransactionHashesCacheKey = (chainId: number, positionId: Hex) => {
  return path.join(getCacheDir(), `${chainId}_${positionId}_txs.json`)
}

export const getTransactionHashes = async (chainId: number, positionId: Hex) => {
  const cacheKey = getTransactionHashesCacheKey(chainId, positionId)
  
  try {
    const cached = await fs.readFile(cacheKey, 'utf-8')
    return JSON.parse(cached, reviver) as Hex[]
  } catch (e) {
    // Cache miss, fetch from chain
    const logs = await clients[chainId].getContractEvents({
      address: "0x6Cae28b3D09D8f8Fc74ccD496AC986FC84C0C24E",
      abi: contangoAbi,
      eventName: "PositionUpserted",
      args: { positionId },
      fromBlock: 0n
    })

    const txHashes = Array.from(new Set(logs.map(x => x.transactionHash)))
    
    // Ensure cache directory exists
    await fs.mkdir(getCacheDir(), { recursive: true })
    
    // Save to cache
    await fs.writeFile(cacheKey, JSON.stringify(txHashes, replacer, 2))
    
    return txHashes
  }
}

export const lotsAreTheSame = (lot1: Lot, lot2: Lot) => {
  return lot1.id === lot2.id &&
    lot1.size === lot2.size &&
    lot1.openCost === lot2.openCost &&
    lot1.closedAtBlock === lot2.closedAtBlock
}
