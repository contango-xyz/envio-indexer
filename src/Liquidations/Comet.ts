import { CometLiquidations } from "generated";
import { eventProcessor } from "../accounting/processTransactions";
import { getBalancesAtBlock, getERC20Balance, getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId } from "../utils/ids";
import { EventType, LiquidationEvent } from "../utils/types";
import { erc20Abi, getContract } from "viem";

CometLiquidations.AbsorbCollateral.handler(async ({ event, context }) => {
  const snapshot = await eventProcessor.getOrLoadSnapshotFromProxyAddress(event, event.params.borrower, context)
  if (!snapshot) return
  const { position } = snapshot
  const { contangoPositionId } = position
  
  const { lendingProfitToSettle, debtCostToSettle, collateralBefore, debtBefore } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })
  const { debt: debtAfter, collateral: collateralAfter } = await getBalancesAtBlock(event.chainId, position.contangoPositionId, event.block.number)
  const debtDelta = debtAfter - debtBefore
  const collateralDelta = collateralAfter - collateralBefore
  
  let cashflowInDebtToken = 0n

  if ((collateralDelta + position.netCollateral) === 0n) {
    const proxyBalance = await getERC20Balance({ chainId: event.chainId, tokenAddress: event.srcAddress, blockNumber: event.block.number, address: event.params.borrower })
    cashflowInDebtToken -= proxyBalance
  }

  const liquidationEvent: LiquidationEvent = {
    id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
    chainId: event.chainId,
    contangoPositionId,
    collateralDelta,
    debtDelta,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    lendingProfitToSettle,
    debtCostToSettle,
    cashflowInDebtToken,
    eventType: EventType.LIQUIDATION,
  }

  await eventProcessor.processEvent(liquidationEvent, context)

}, { wildcard: true });