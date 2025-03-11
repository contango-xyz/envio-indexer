import { Lot, Position, Token, handlerContext } from "generated/src/Types.gen"
import { getPairForPositionId, getPosition } from "../utils/common"
import { StoreKey, createStoreKey, createStoreKeyFromEvent, decodeStoreKey } from "../utils/ids"
import { singletonPromise } from "../utils/promise"
import { ContangoEvents, EventType } from "../utils/types"
import { organiseEvents } from "./helpers/eventStore"
import { handleMigrations } from "./helpers/migrations"
import { loadLots } from "./helpers/saveAndLoad"
import { GenericEvent } from "./lotsAccounting"
import { processEventsForPosition } from "./processEvents"
import { zeroAddress } from "viem"

type PositionSnapshot = {
  position: Position // this will be a snapshot of the position that the transaction is relevant to. In case of a migration, this will be the old position.
  lots: Lot[] // this will be a snapshot of the lots that are relevant to the position. In case of a migration, this will be the old lots.
  collateralToken: Token
  debtToken: Token
}

class TransactionProcessor {
  transactionKey: StoreKey
  chainId: number

  private processedHighwatermark = 0

  public events: ContangoEvents[] = []
  private snapshot: PositionSnapshot | null = null

  constructor(transactionKey: StoreKey) {
    const { chainId } = decodeStoreKey(transactionKey)
    this.transactionKey = transactionKey
    this.chainId = chainId
  }

  private async runProcessEvents(snapshot: PositionSnapshot, events: ContangoEvents[]) {
    const { position, lots, collateralToken, debtToken } = snapshot
    if (events.length === 0) throw new Error(`Attempted to call eventProcessor with no events for position_id ${position.id}`)
    const organisedEvents = organiseEvents(events)
    const { positionUpsertedEvents, nftTransferEvents } = organisedEvents
    
    // ideally we'd just look for the PositionMigrated event, but the initial implementation of migrations didn't emit that event so this is more robust
    const positionIds = positionUpsertedEvents.reduce((acc, curr) => acc.add(curr.contangoPositionId), new Set<string>())

    const isMigration = nftTransferEvents.find(x => x.to === zeroAddress) && nftTransferEvents.find(x => x.from === zeroAddress)
    
    if (isMigration) {
      const [_, newContangoPositionId] = Array.from(positionIds)
      return handleMigrations({ position, lots, debtToken, collateralToken, organisedEvents, newContangoPositionId })
    }
    if (positionIds.size <= 1) return processEventsForPosition({ organisedEvents, position, lots, debtToken, collateralToken })

    console.log(`unusual transaction: ${events[0].chainId}`, positionIds)
    return { saveResult: () => {} }
  }

  private async processEvents(context: handlerContext) {
    if (this.snapshot) {
      if (this.processedHighwatermark === this.events.length) return // already processed. no need to do it again

      try {
        const { position, lots, collateralToken, debtToken } = this.snapshot
        const { saveResult } = await this.runProcessEvents({ position, lots, collateralToken, debtToken }, this.events)
        saveResult(context)
        this.processedHighwatermark = this.events.length
      } catch (e) {
        console.log('failed to process events', this.events)
        throw e
      }
    }
  }

  private async loadSnapshot(contangoPositionId: string, chainId: number, context: handlerContext) {
    const [position, { collateralToken, debtToken }] = await Promise.all([
      getPosition({ chainId, contangoPositionId, context }),
      getPairForPositionId({ chainId, contangoPositionId, context })
    ])
    const lots = await loadLots({ position, context })
    return { position, lots, collateralToken, debtToken }
  }

  // only needed for liquidations
  public async getOrLoadSnapshot(contangoPositionId: string, context: handlerContext) {
    if (this.snapshot) return this.snapshot
    this.snapshot = await singletonPromise(`loadSnapshot-${this.transactionKey}`, () => this.loadSnapshot(contangoPositionId, this.chainId, context))
    return this.snapshot
  }

  async process(event: ContangoEvents, context: handlerContext) {
    this.events.push(event)
    switch (event.eventType) {
      case EventType.POSITION_UPSERTED:
      case EventType.LIQUIDATION: {
        await this.getOrLoadSnapshot(event.contangoPositionId, context)
        break
      }
    }

    switch (event.eventType) {
      case EventType.END_STRATEGY:
      case EventType.LIQUIDATION: {
        await this.processEvents(context)
        break
      }
    }
  }

  async cleanup(context: handlerContext) {
    return this.processEvents(context)
  }

}

type ChainId = number

class EventProcessor {
  private static instance: EventProcessor
  private processors: Map<ChainId, TransactionProcessor> = new Map()

  private constructor() {}

  static getInstance() {
    if (!EventProcessor.instance) {
      EventProcessor.instance = new EventProcessor()
    }
    return EventProcessor.instance
  }

  private async getTransactionProcessorAndRunCleanup(chainId: ChainId, transactionKey: StoreKey, context: handlerContext) {
    const processorMaybe = this.processors.get(chainId)
    if (!processorMaybe) {
      this.processors.set(chainId, new TransactionProcessor(transactionKey))
    } else if (processorMaybe.transactionKey !== transactionKey) {
      await processorMaybe.cleanup(context)
      const newProcessor = new TransactionProcessor(transactionKey)
      this.processors.set(chainId, newProcessor)
    }
    const processor = this.processors.get(chainId)
    if (processor?.transactionKey !== transactionKey) {
      throw new Error(`Processor for chainId ${chainId} and transactionKey ${transactionKey} has changed`)
    }
    return processor
  }

  async processEvent(event: ContangoEvents, context: handlerContext) {
    const transactionKey = createStoreKey(event)
    const chainId = event.chainId
    const processor = await this.getTransactionProcessorAndRunCleanup(chainId, transactionKey, context)
    await processor.process(event, context)
  }

  async getOrLoadSnapshot(event: GenericEvent, positionId: string, context: handlerContext) {
    const transactionKey = createStoreKeyFromEvent(event)
    const transactionProcessor = await this.getTransactionProcessorAndRunCleanup(event.chainId, transactionKey, context)
    return transactionProcessor.getOrLoadSnapshot(positionId, context)
  }

}

export const eventProcessor = EventProcessor.getInstance()

