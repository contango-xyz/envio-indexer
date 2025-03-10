import { ContangoLiquidationEvent, EulerLiquidations } from "generated";
import { getContract, Hex, parseAbi } from "viem";
import { eventsReducer } from "../accounting/processEvents";
import { clients } from "../clients";
import { eventStore } from "../Store";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId, createStoreKeyFromEvent } from "../utils/ids";
import { EventType } from "../utils/types";
import { getPositionIdForProxyAddress } from "./common";

const eulerAbi = parseAbi(["function convertToAssets(uint256 shares) external view returns (uint256 assets)"])

EulerLiquidations.LiquidateEuler.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.violator, context })

  if (positionId) {
    const storeKey = createStoreKeyFromEvent(event)
    const snapshot = await eventStore.getCurrentPositionSnapshot({ storeKey, positionId, context })
    if (!snapshot) {
      console.error(`no snapshot found for positionId: ${positionId} - chainId: ${event.chainId}`, event)
      return
    }

    const { position } = snapshot

    const collateralTaken = await getContract({
      abi: eulerAbi,
      address: event.params.collateral as Hex,
      client: clients[event.chainId],
    }).read.convertToAssets([event.params.yieldBalance], { blockNumber: BigInt(event.block.number) })

    const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number - 1, position })
    
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
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)
    eventStore.addLog({ ...liquidationEvent, eventType: EventType.LIQUIDATION })

    await eventsReducer({ ...snapshot, context })
  }
}, { wildcard: true });