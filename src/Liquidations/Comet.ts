import {
  CometLiquidations,
  ContangoLiquidationEvent
} from "generated";
import { eventsReducer } from "../accounting/processEvents";
import { eventStore } from "../Store";
import { getBalancesAtBlock, getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId, createStoreKeyFromEvent } from "../utils/ids";
import { EventType } from "../utils/types";
import { getPositionIdForProxyAddress } from "./common";

CometLiquidations.AbsorbCollateral.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.borrower, context })
  
  if (positionId) {
    const storeKey = createStoreKeyFromEvent(event)
    const snapshot = await eventStore.getCurrentPositionSnapshot({ storeKey, positionId, context })
    if (!snapshot) {
      console.error(`no snapshot found for positionId: ${positionId} - chainId: ${event.chainId}`, event)
      return
    }
    const { position } = snapshot
    const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })
    const { debt: debtAfter, collateral: collateralAfter } = await getBalancesAtBlock(event.chainId, position.contangoPositionId, event.block.number)
    const debtDelta = debtAfter - position.debt
    const collateralDelta = collateralAfter - position.collateral

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
      chainId: event.chainId,
      contangoPositionId: positionId,
      collateralDelta,
      debtDelta,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
    }
    
    context.ContangoLiquidationEvent.set(liquidationEvent)
    eventStore.addLog({ ...liquidationEvent, eventType: EventType.LIQUIDATION })

    await eventsReducer({ ...snapshot, context })
  }

}, { wildcard: true });