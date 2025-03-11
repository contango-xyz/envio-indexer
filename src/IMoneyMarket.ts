import { IMoneyMarket } from "generated";
import { createTokenId } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { CollateralEvent, DebtEvent, EventType } from "./utils/types";
import { getPositionSafe } from "./utils/common";
import { eventProcessor } from "./accounting/processTransactions";

// Debt events
IMoneyMarket.Borrowed.handler(async ({ event, context }) => {
  // there are other events that match this wildcard event signature. We check if this position exists to ensure we only process the correct event
  // using the `registerContract` function from envio results in terrible performance loss, so this is preferred
  const position = await getPositionSafe({ chainId: event.chainId, positionId: event.params.positionId, context })
  if (!position) return

  const eventId = createEventId({ ...event, eventType: EventType.DEBT })
  const entity: DebtEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    debtDelta: event.params.amount,
    asset_id: createTokenId({ chainId: event.chainId, address: event.params.asset }),
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    eventType: EventType.DEBT,
  }

  await eventProcessor.processEvent(entity, context)

}, { wildcard: true })

IMoneyMarket.Repaid.handler(async ({ event, context }) => {
  // there are other events that match this wildcard event signature. We check if this position exists to ensure we only process the correct event
  // using the `registerContract` function from envio results in terrible performance loss, so this is preferred

  // TODO: maybe remove this check? (I think it's redundant)
  const position = await getPositionSafe({ chainId: event.chainId, positionId: event.params.positionId, context })
  if (!position) return

  const eventId = createEventId({ ...event, eventType: EventType.DEBT })
  const entity: DebtEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    debtDelta: -event.params.amount,
    asset_id: createTokenId({ chainId: event.chainId, address: event.params.asset }),
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    eventType: EventType.DEBT,
  }

  await eventProcessor.processEvent(entity, context)

}, { wildcard: true })

// Collateral events
IMoneyMarket.Lent.handler(async ({ event, context }) => {
  // there are other events that match this wildcard event signature. We check if this position exists to ensure we only process the correct event
  // using the `registerContract` function from envio results in terrible performance loss, so this is preferred
  const position = await getPositionSafe({ chainId: event.chainId, positionId: event.params.positionId, context })
  if (!position) return

  const eventId = createEventId({ ...event, eventType: EventType.COLLATERAL })
  const entity: CollateralEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    collateralDelta: event.params.amount,
    asset_id: createTokenId({ chainId: event.chainId, address: event.params.asset }),
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    eventType: EventType.COLLATERAL,
  }

  await eventProcessor.processEvent(entity, context)

}, { wildcard: true })

IMoneyMarket.Withdrawn.handler(async ({ event, context }) => {
  // there are other events that match this wildcard event signature. We check if this position exists to ensure we only process the correct event
  // using the `registerContract` function from envio results in terrible performance loss, so this is preferred
  const position = await getPositionSafe({ chainId: event.chainId, positionId: event.params.positionId, context })
  if (!position) return

  const eventId = createEventId({ ...event, eventType: EventType.COLLATERAL })
  const entity: CollateralEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    collateralDelta: -event.params.amount,
    asset_id: createTokenId({ chainId: event.chainId, address: event.params.asset }),
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    eventType: EventType.COLLATERAL,
  }

  await eventProcessor.processEvent(entity, context)

}, { wildcard: true })
