import {
  ContangoLiquidationEvent,
  ExactlyLiquidations
} from "generated";
import { eventsReducer } from "../accounting/processEvents";
import { getBalancesAtBlock, getPairForPositionId, getPosition } from "../utils/common";
import { createLiquidationId } from "../utils/ids";
import { max } from "../utils/math-helpers";
import { getLiquidationPenalty, getMarkPrice, getPositionIdForProxyAddress } from "./common";

ExactlyLiquidations.LiquidateExactly.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.borrower, context })

  if (positionId) {
    const balancesBefore = await getBalancesAtBlock(event.chainId, positionId, event.block.number - 1)
    const position = await getPosition({ chainId: event.chainId, positionId, context })
    const markPrice = await getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, context })

    const lendingProfitToSettle = max(balancesBefore.collateral - position.collateral, 0n)
    const debtCostToSettle = max(balancesBefore.debt - position.debt, 0n)
    const { collateralToken } = await getPairForPositionId({ chainId: event.chainId, positionId, context })

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createLiquidationId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex }),
      chainId: event.chainId,
      positionId,
      collateralDelta: -event.params.seizedAssets,
      debtDelta: -event.params.assets,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta: event.params.seizedAssets, debtDelta: event.params.assets, markPrice }),
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)

    await eventsReducer(
      {
        chainId: event.chainId,
        blockNumber: event.block.number,
        transactionHash: event.transaction.hash,
        logIndex: event.logIndex,
        positionId,
        blockTimestamp: event.block.timestamp,
      },
      context
    )
  }
}, { wildcard: true });

