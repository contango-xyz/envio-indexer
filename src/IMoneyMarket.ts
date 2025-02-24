import { ContangoCollateralEvent, ContangoDebtEvent, IMoneyMarket } from "generated";
import { eventStore } from "./Store";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { EventType } from "./utils/types";

// Debt events
IMoneyMarket.Borrowed.handler(async ({ event, context }) => {
  const asset = await getOrCreateToken({ address: event.params.asset, chainId: event.chainId, context })
  const eventId = createEventId({ ...event, eventType: EventType.DEBT })
  const entity: ContangoDebtEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    debtDelta: event.params.amount,
    asset_id: asset.id,
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoDebtEvent.set(entity)
  eventStore.addLog({ event, contangoEvent: { ...entity, eventType: EventType.DEBT } })

}, { wildcard: true })

IMoneyMarket.Repaid.handler(async ({ event, context }) => {
  const asset = await getOrCreateToken({ address: event.params.asset, chainId: event.chainId, context })
  const eventId = createEventId({ ...event, eventType: EventType.DEBT })
  const entity: ContangoDebtEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    debtDelta: -event.params.amount,
    asset_id: asset.id,
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoDebtEvent.set(entity)
  eventStore.addLog({ event, contangoEvent: { ...entity, eventType: EventType.DEBT } })

}, { wildcard: true })

// Collateral events

IMoneyMarket.Lent.handler(async ({ event, context }) => {
  const asset = await getOrCreateToken({ address: event.params.asset, chainId: event.chainId, context })
  const eventId = createEventId({ ...event, eventType: EventType.COLLATERAL })
  const entity: ContangoCollateralEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    collateralDelta: event.params.amount,
    asset_id: asset.id,
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoCollateralEvent.set(entity)
  eventStore.addLog({ event, contangoEvent: { ...entity, eventType: EventType.COLLATERAL } })

}, { wildcard: true })

IMoneyMarket.Withdrawn.handler(async ({ event, context }) => {
  const asset = await getOrCreateToken({ address: event.params.asset, chainId: event.chainId, context })
  const eventId = createEventId({ ...event, eventType: EventType.COLLATERAL })
  const entity: ContangoCollateralEvent = {
    id: eventId,
    contangoPositionId: event.params.positionId,
    collateralDelta: -event.params.amount,
    asset_id: asset.id,
    balanceBefore: event.params.balanceBefore,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoCollateralEvent.set(entity)
  eventStore.addLog({ event, contangoEvent: { ...entity, eventType: EventType.COLLATERAL } })

}, { wildcard: true })
