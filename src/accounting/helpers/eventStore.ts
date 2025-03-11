import { CollateralEvent, ContangoEvents, DebtEvent, EventType, FeeCollectedEvent, LiquidationEvent, PositionMigratedEvent, PositionUpsertedEvent, SwapEvent, TransferEvent, TransferNFT } from "../../utils/types";

export const organiseEvents = (events: ContangoEvents[]) => {
  return events.reduce((record, event) => {
    record.allEvents.push(event)
    if (event.eventType === EventType.FEE_COLLECTED) record.feeEvents.push(event)
    else if (event.eventType === EventType.POSITION_UPSERTED) record.positionUpsertedEvents.push(event)
    else if (event.eventType === EventType.SWAP_EXECUTED) record.swapEvents.push(event)
    else if (event.eventType === EventType.DEBT) record.debtEvents.push(event)
    else if (event.eventType === EventType.COLLATERAL) record.collateralEvents.push(event)
    else if (event.eventType === EventType.LIQUIDATION) record.liquidationEvents.push(event)
    else if (event.eventType === EventType.TRANSFER) record.transferEvents.push(event)
    else if (event.eventType === EventType.MIGRATED) record.migrationEvents.push(event)
    else if (event.eventType === EventType.TRANSFER_NFT) record.nftTransferEvents.push(event)
    else record.allEvents.pop() // we optimistically add the event to the record, but if it's not one of the expected types, we remove it
    return record
  },
  { allEvents: [] as ContangoEvents[], nftTransferEvents: [] as TransferNFT[], migrationEvents: [] as PositionMigratedEvent[], transferEvents: [] as TransferEvent[], feeEvents: [] as FeeCollectedEvent[], positionUpsertedEvents: [] as PositionUpsertedEvent[], swapEvents: [] as SwapEvent[], debtEvents: [] as DebtEvent[], collateralEvents: [] as CollateralEvent[], liquidationEvents: [] as LiquidationEvent[] }
 )
}

export type OrganisedEvents = ReturnType<typeof organiseEvents>

