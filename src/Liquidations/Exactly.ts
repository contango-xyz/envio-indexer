import {
  ContangoLiquidationEvent,
  ExactlyLiquidations
} from "generated";
import { getMarkPrice, getPositionIdForProxyAddress, createLiquidationFillItem } from "./common";
import { createLiquidationId } from "../utils/ids";
import { getBalancesAtBlock } from "../utils/common";
import { EventType } from "../utils/types";

ExactlyLiquidations.LiquidateExactly.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.borrower, context })

  if (positionId) {
    const balancesBefore = await getBalancesAtBlock(event.chainId, positionId, event.block.number - 1)
    const markPrice = await getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, context })

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createLiquidationId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex }),
      eventType: EventType.LIQUIDATION,
      chainId: event.chainId,
      positionId,
      collateralTaken: event.params.seizedAssets,
      debtRepaid: event.params.assets,
      tradedBy: event.params.receiver,
      proxy: event.params.borrower,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      collateralBefore: balancesBefore.collateral,
      debtBefore: balancesBefore.debt,
      markPrice,
      srcContract: event.srcAddress,
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)

    await createLiquidationFillItem({ liquidationEvent, context })
  }
}, { wildcard: true });

