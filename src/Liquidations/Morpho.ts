import { MorphoLiquidations } from "generated";
import { eventProcessor } from "../accounting/processTransactions";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId } from "../utils/ids";
import { EventType, LiquidationEvent } from "../utils/types";

MorphoLiquidations.LiquidateMorpho.handler(async ({ event, context }) => {
  const snapshot = await eventProcessor.getOrLoadSnapshotFromProxyAddress(event, event.params.borrower, context)
  if (!snapshot) return
  const { position } = snapshot
  const { contangoPositionId } = position

  const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })

  const liquidationEvent: LiquidationEvent = {
    id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
    chainId: event.chainId,
    contangoPositionId,
    collateralDelta: -event.params.seizedAssets,
    debtDelta: -event.params.repaidAssets,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    lendingProfitToSettle,
    debtCostToSettle,
    cashflowInDebtToken: 0n,
    eventType: EventType.LIQUIDATION,
  }

  await eventProcessor.processEvent(liquidationEvent, context)
}, { wildcard: true });