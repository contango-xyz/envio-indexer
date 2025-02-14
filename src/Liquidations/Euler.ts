import {
  ContangoLiquidationEvent,
  EulerLiquidations
} from "generated";
import { getContract, Hex, parseAbi } from "viem";
import { eventsReducer } from "../accounting/processEvents";
import { clients } from "../clients";
import { getBalancesAtBlock, getPairForPositionId, getPosition } from "../utils/common";
import { createLiquidationId } from "../utils/ids";
import { max } from "../utils/math-helpers";
import { getLiquidationPenalty, getMarkPrice, getPositionIdForProxyAddress } from "./common";

const eulerAbi = parseAbi(["function convertToAssets(uint256 shares) external view returns (uint256 assets)"])

EulerLiquidations.LiquidateEuler.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.violator, context })

  if (positionId) {
    const collateralTaken = await getContract({
      abi: eulerAbi,
      address: event.params.collateral as Hex,
      client: clients[event.chainId],
    }).read.convertToAssets([event.params.yieldBalance], { blockNumber: BigInt(event.block.number) })
    const balancesBefore = await getBalancesAtBlock(event.chainId, positionId, event.block.number - 1)
    const position = await getPosition({ chainId: event.chainId, positionId, context })
    const { debtToken, collateralToken } = await getPairForPositionId({ chainId: event.chainId, positionId, context })
    const markPrice = await getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, debtToken })

    const lendingProfitToSettle = max(balancesBefore.collateral - position.collateral, 0n)
    const debtCostToSettle = max(balancesBefore.debt - position.debt, 0n)
    
    const liquidationEvent: ContangoLiquidationEvent = {
      id: createLiquidationId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex }),
      chainId: event.chainId,
      positionId,
      collateralDelta: -collateralTaken,
      debtDelta: -event.params.repayAssets,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta: collateralTaken, debtDelta: event.params.repayAssets, markPrice }),
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
