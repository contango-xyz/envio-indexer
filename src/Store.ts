import { handlerContext, Instrument, Lot, Position, Token } from "generated"
import { EventWithPositionId, GenericEvent, loadLots } from "./accounting/lotsAccounting"
import { eventsReducer } from "./accounting/processEvents"
import { getPairForPositionId, getPosition } from "./utils/common"
import { createStoreKey, decodeStoreKey, StoreKey } from "./utils/ids"
import { recordKeys } from "./utils/record-utils"
import { ContangoEvents } from "./utils/types"

type Store = Record<StoreKey, ContangoEvents[]>

export type PositionSnapshot = {
  position: Position
  debtToken: Token
  collateralToken: Token
  instrument: Instrument
  lots: Lot[]
  event: GenericEvent
}

class EventStore {
  private currentPositionSnapshot: Record<StoreKey, PositionSnapshot | null> = { }
  private store: Store = {}
  private static instance: EventStore
  private static readonly MAX_EVENTS_PER_TX = 1000 // Limit events per transaction

  private constructor() {}

  static getInstance(): EventStore {
    if (!EventStore.instance) {
      EventStore.instance = new EventStore()
    }
    return EventStore.instance
  }

  async getCurrentPositionSnapshot({ event, context }: { event: EventWithPositionId, context: handlerContext }) {
    const result = this.currentPositionSnapshot[createStoreKey(event)]
    if (!result) {
      await this.cleanup(event.chainId, event.block.number, context)
      try {
        const position = await getPosition({ chainId: event.chainId, positionId: event.params.positionId, context })
        const pair = await getPairForPositionId({ chainId: event.chainId, positionId: event.params.positionId, context })
        const lots = await loadLots({ position, context })
        const snapshot: PositionSnapshot = { position, ...pair, lots, event }
        this.currentPositionSnapshot[createStoreKey(event)] = snapshot

        return snapshot
      } catch (e) {
        console.error('error getting position snapshot: ', e)
        return null
      }
    }
    return result
  }

  async setPositionSnapshot(snapshot: PositionSnapshot) {
    this.currentPositionSnapshot[createStoreKey(snapshot.event)] = snapshot
  }

  deletePositionSnapshot(event: GenericEvent) {
    delete this.currentPositionSnapshot[createStoreKey(event)]
  }

  addLog({ event, contangoEvent }: {
    event: GenericEvent
    contangoEvent: ContangoEvents
  }): void {
    const key = createStoreKey({ chainId: contangoEvent.chainId, block: { number: event.block.number }, transaction: { hash: event.transaction.hash } })
    
    if (!this.store[key]) {
      this.store[key] = []
    }

    // Prevent excessive event accumulation per transaction
    if (this.store[key].length >= EventStore.MAX_EVENTS_PER_TX) {
      console.warn(`Warning: Key ${key} has exceeded ${EventStore.MAX_EVENTS_PER_TX} events`)
      return
    }

    this.store[key].push(contangoEvent)
  }

  getContangoEvents(event: GenericEvent) {
    const key = createStoreKey(event)
    const events = this.store[key] || []

    return events
  }

  async cleanup(cleanupChainId: number, currentBlock: number, context: handlerContext) {
    const keysToDelete: StoreKey[] = []
    for (const key of recordKeys(this.store)) {
      const { chainId, blockNumber } = decodeStoreKey(key)
      if (chainId !== cleanupChainId) continue
      
      // More aggressive cleanup - remove events from completed transactions
      if (blockNumber < currentBlock) {
        keysToDelete.push(key)
      }
    }
    
    // Batch delete to improve performance
    for (const key of keysToDelete) {
      const snapshot = this.currentPositionSnapshot[key]
      if (!snapshot) continue
      await eventsReducer({ context, ...snapshot })
      delete this.currentPositionSnapshot[key]
      delete this.store[key]
    }
  }
}

export const eventStore = EventStore.getInstance()

