import {
  ContangoLiquidationEvent,
  EulerLiquidations
} from "generated";
import { getContract, Hex, parseAbi } from "viem";
import { eventsReducer } from "../accounting/processEvents";
import { clients } from "../clients";
import { eventStore } from "../Store";
import { getBalancesAtBlock, getMarkPrice } from "../utils/common";
import { createEventId } from "../utils/ids";
import { max } from "../utils/math-helpers";
import { EventType } from "../utils/types";
import { getLiquidationPenalty, getPositionIdForProxyAddress } from "./common";

const eulerAbi = parseAbi(["function convertToAssets(uint256 shares) external view returns (uint256 assets)"])

EulerLiquidations.LiquidateEuler.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.violator, context })

  if (positionId) {
    const snapshot = await eventStore.getCurrentPositionSnapshot({ event: { ...event, params: { positionId } }, context })
    if (!snapshot) {
      console.error(`no snapshot found for positionId: ${positionId} - chainId: ${event.chainId}`, event)
      return
    }

    const { position, collateralToken, debtToken } = snapshot
    const collateralTaken = await getContract({
      abi: eulerAbi,
      address: event.params.collateral as Hex,
      client: clients[event.chainId],
    }).read.convertToAssets([event.params.yieldBalance], { blockNumber: BigInt(event.block.number) })
    const [balancesBefore, markPrice] = await Promise.all([
      getBalancesAtBlock(event.chainId, positionId, event.block.number - 1),
      getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, debtToken })
    ])

    const lendingProfitToSettle = max(balancesBefore.collateral - position.collateral, 0n)
    const debtCostToSettle = max(balancesBefore.debt - position.debt, 0n)
    
    const liquidationEvent: ContangoLiquidationEvent = {
      id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
      chainId: event.chainId,
      contangoPositionId: positionId,
      collateralDelta: -collateralTaken,
      debtDelta: -event.params.repayAssets,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta: collateralTaken, debtDelta: event.params.repayAssets, markPrice }),
      markPrice,
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)
    eventStore.addLog({ event: { ...event, params: { positionId } }, contangoEvent: { ...liquidationEvent, eventType: EventType.LIQUIDATION } })

    await eventsReducer({ ...snapshot, context })
  }
}, { wildcard: true });