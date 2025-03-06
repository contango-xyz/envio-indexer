import { ContangoLiquidationEvent, ExactlyLiquidations } from "generated";
import { eventsReducer } from "../accounting/processEvents";
import { eventStore } from "../Store";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId, createStoreKeyFromEvent } from "../utils/ids";
import { EventType } from "../utils/types";
import { getPositionIdForProxyAddress } from "./common";

ExactlyLiquidations.LiquidateExactly.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.borrower, context })

  if (positionId) {
    const storeKey = createStoreKeyFromEvent(event)
    const snapshot = await eventStore.getCurrentPositionSnapshot({ storeKey, positionId, context })
    if (!snapshot) {
      console.error(`no snapshot found for positionId: ${positionId} - chainId: ${event.chainId}`, event)
      return
    }

    const { position } = snapshot
    const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number - 1, position })

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
      chainId: event.chainId,
      contangoPositionId: positionId,
      collateralDelta: -event.params.seizedAssets,
      debtDelta: -event.params.assets,
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