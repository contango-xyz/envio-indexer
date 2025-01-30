import { ERC20_Transfer_event, Position } from "generated"
import { decodeStoreKey, eventIdToStoreKey } from "./utils/ids"
import { StoreKey, createStoreKey } from "./utils/ids"
import { EventId } from "./utils/ids"
import { ContangoEvents } from "./utils/types"
import { recordKeys } from "./utils/record-utils"
import { Chain } from "viem"

type Store = Record<StoreKey, ContangoEvents[]>

// `${chainId}-${blockNumber}-${transactionHash}`
type CurrentPositionKey = `${number}-${number}-${string}`

class EventStore {
  private currentPosition: Record<CurrentPositionKey, Position> = {}
  private store: Store = {}
  private static instance: EventStore

  private constructor() {}

  static getInstance(): EventStore {
    if (!EventStore.instance) {
      EventStore.instance = new EventStore()
    }
    return EventStore.instance
  }

  private createCurrentPositionId({ chainId, blockNumber, transactionHash }: { chainId: Chain['id']; blockNumber: number; transactionHash: string }): CurrentPositionKey {
    return `${chainId}-${blockNumber}-${transactionHash}`
  }

  // call this whenever processing an event that has the position id as a parameter
  setCurrentPosition({ position, blockNumber, transactionHash }: { position: Position; blockNumber: number; transactionHash: string }) {
    this.currentPosition[this.createCurrentPositionId({ chainId: position.chainId, blockNumber, transactionHash })] = position
  }

  // we use this to get the current position that's being processed when we're processing an event that doesn't have the position id as a parameter
  getCurrentPosition({ chainId, blockNumber, transactionHash }: { chainId: Chain['id'], blockNumber: number; transactionHash: string }) {
    const position = this.currentPosition[this.createCurrentPositionId({ chainId, blockNumber, transactionHash })]
    if (!position) return null
    return { ...position }
  }

  addLog({ eventId, contangoEvent }: {
    eventId: EventId
    contangoEvent: ContangoEvents
  }): void {
    const key = eventIdToStoreKey(eventId)
    
    if (!this.store[key]) {
      this.store[key] = []
    }

    this.store[key].push(contangoEvent)
  }

  getEvents({ chainId, blockNumber, transactionHash, cleanup = false }: { chainId: number; blockNumber: number; transactionHash: string; cleanup?: boolean }) {
    const key = createStoreKey({ chainId, blockNumber, transactionHash })
    const events = this.store[key] || []
    if (cleanup) delete this.store[key]
    return events
  }

  storeEvents(key: StoreKey, events: ContangoEvents[]) {
    this.store[key] = events
  }

  processEvents<T extends ContangoEvents>(
    key: StoreKey, 
    predicate: (event: ContangoEvents) => event is T
  ): T[] {
    const events = this.store[key] || []
    const [matching, remaining] = events.reduce<[T[], ContangoEvents[]]>(
      (acc, event) => {
        if (predicate(event)) {
          acc[0].push(event)
        } else {
          acc[1].push(event)
        }
        return acc
      },
      [[], []]
    )
    
    // Store the remaining events back
    this.storeEvents(key, remaining)
    
    return matching
  }

  cleanup(cleanupChainId: number, currentBlock: number) {
    const MAX_BLOCK_AGE = 100 // Adjust as needed
    
    for (const key of recordKeys(this.store)) {
      const { chainId, blockNumber } = decodeStoreKey(key)
      if (chainId !== cleanupChainId) continue
      if (blockNumber < currentBlock - MAX_BLOCK_AGE) {
        delete this.store[key]
      }
    }
  }
}

export const eventStore = EventStore.getInstance()

type Erc20Store = Record<Chain['id'], { transactionHash: string, events: ERC20_Transfer_event[] }>

class Erc20EventStore {
  private store: Erc20Store = {}
  private static instance: Erc20EventStore

  private constructor() {}

  static getInstance(): Erc20EventStore {
    if (!Erc20EventStore.instance) {
      Erc20EventStore.instance = new Erc20EventStore()
    }
    return Erc20EventStore.instance
  }

  addLog({ chainId, transactionHash, erc20Event }: {
    chainId: number
    transactionHash: string
    erc20Event: ERC20_Transfer_event
  }): void {

    // cleans up memory if the transaction hash has changed
    if (this.store[chainId]?.transactionHash !== transactionHash) {
      this.store[chainId] = { transactionHash, events: [] }
    }

    this.store[chainId].events.push(erc20Event)
  }

  processEvents(chainId: number) {
    // no need to do cleanup here as it's already handled by the addLog method
    const res = this.store[chainId]?.events || []
    delete this.store[chainId]
    return res
  }

}

export const erc20EventStore = Erc20EventStore.getInstance()
