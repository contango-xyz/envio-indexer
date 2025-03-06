import { handlerContext, Instrument, Lot, Position, Token } from "generated"
import { EventWithPositionId, GenericEvent, loadLots } from "./accounting/lotsAccounting"
import { eventsReducer } from "./accounting/processEvents"
import { getPairForPositionId, getPosition } from "./utils/common"
import { createStoreKey, decodeStoreKey, StoreKey } from "./utils/ids"
import { recordFromEntries, recordKeys } from "./utils/record-utils"
import { ContangoEvents } from "./utils/types"
import { wrappedNativeMap } from "./utils/constants"

type Store = Record<StoreKey, ContangoEvents[]>

export type PositionSnapshot = {
  position: Position
  debtToken: Token
  collateralToken: Token
  instrument: Instrument
  lots: Lot[]
  storeKey: StoreKey
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

  // the purpose of this function is that the first time it's called in a transaction, it will load a snapshot of the position/lots
  // any subsequent calls within the same transaction will return the same snapshot, aka state of position at the START of the transaction
  // this is because the order of the events is not necessarily in the order that we need them with regards to processing correctly, and we 
  // need to avoid processing events on top of a postion snapshot that has state already (partially) applied
  async getCurrentPositionSnapshot({ storeKey, context, positionId }: { storeKey: StoreKey, positionId: string, context: handlerContext }) {
    const { chainId, blockNumber, transactionHash } = decodeStoreKey(storeKey)
    const result = this.currentPositionSnapshot[storeKey]
    if (!result) {
      // this means that this fn is being called for the first time in the transaction.
      // we run cleanup to remove any snapshots that are left behind from previous transactions
      await this.cleanup(chainId, blockNumber, context)
      const position = await getPosition({ chainId, positionId, context })
      const pair = await getPairForPositionId({ chainId, positionId, context })
      const lots = await loadLots({ position, context })
      const snapshot: PositionSnapshot = { position, ...pair, lots, storeKey }

      // store the snapshot for future calls in the same transaction
      this.currentPositionSnapshot[storeKey] = snapshot

      return snapshot
    }
    const events = this.getContangoEvents(storeKey) // because it's the same reference, this shouldn't be needed. TODO: test removing this and see if tests still pass
    return { ...result, events }
  }

  deletePositionSnapshot(storeKey: StoreKey) {
    delete this.currentPositionSnapshot[storeKey]
  }

  addLog(contangoEvent: ContangoEvents): void {
    const storeKey = createStoreKey(contangoEvent)

    if (!this.store[storeKey]) {
      this.store[storeKey] = []
    }

    // Prevent excessive event accumulation per transaction
    if (this.store[storeKey].length >= EventStore.MAX_EVENTS_PER_TX) {
      throw new Error(`Cleanup is not working as intended, key ${storeKey} has exceeded ${EventStore.MAX_EVENTS_PER_TX} events. Current events length: ${this.store[storeKey].length}`)
    }

    this.store[storeKey].push(contangoEvent)
  }

  getContangoEvents(storeKey: StoreKey) {
    return this.store[storeKey] || []
  }

  async cleanup(cleanupChainId: number, currentBlock: number, context: handlerContext) {
    for (const key of recordKeys(this.store)) {
      const { chainId, blockNumber } = decodeStoreKey(key)
      if (chainId !== cleanupChainId) continue

      // Remove events from completed transactions
      if (blockNumber < currentBlock) {
        const snapshot = this.currentPositionSnapshot[key]
        if (!snapshot) continue
        await eventsReducer({ context, ...snapshot })
        delete this.currentPositionSnapshot[key]
        delete this.store[key]
      }
    }
  }
}

export const eventStore = EventStore.getInstance()

