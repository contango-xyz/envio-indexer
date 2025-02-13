import { ERC20_Transfer_event, Lot, Position } from "generated"
import { decodeStoreKey, eventIdToStoreKey } from "./utils/ids"
import { StoreKey, createStoreKey } from "./utils/ids"
import { EventId } from "./utils/ids"
import { ContangoEvents } from "./utils/types"
import { recordKeys } from "./utils/record-utils"
import { Chain } from "viem"
import { Lot_t, Position_t } from "generated/src/db/Entities.gen"

type Store = Record<StoreKey, ContangoEvents[]>

// `${chainId}-${blockNumber}-${transactionHash}`
type CurrentPositionKey = `${number}-${number}-${string}`

class EventStore {
  private currentPosition: Record<CurrentPositionKey, { position: Position_t, lots: { longLots: Lot_t[], shortLots: Lot_t[] } }> = {}
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
  setCurrentPosition({ position, lots, blockNumber, transactionHash }: { lots: { longLots: Lot[], shortLots: Lot[] }; position: Position; blockNumber: number; transactionHash: string }) {
    this.currentPosition[this.createCurrentPositionId({ chainId: position.chainId, blockNumber, transactionHash })] = { position, lots }
  }

  // we use this to get the current position that's being processed when we're processing an event that doesn't have the position id as a parameter
  getCurrentPosition({ chainId, blockNumber, transactionHash }: { chainId: Chain['id'], blockNumber: number; transactionHash: string }) {
    const result = this.currentPosition[this.createCurrentPositionId({ chainId, blockNumber, transactionHash })]
    if (!result) return null
    return result
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

