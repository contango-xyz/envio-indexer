import { CompoundLiquidations, ContangoLiquidationEvent } from "generated";
import { getContract, Hex, parseAbi } from "viem";
import { eventsReducer } from "../accounting/processEvents";
import { clients } from "../clients";
import { eventStore } from "../Store";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId, createStoreKeyFromEvent } from "../utils/ids";
import { EventType } from "../utils/types";
import { getPositionIdForProxyAddress } from "./common";

const abi = parseAbi(["function exchangeRateCurrent() external view returns (uint256)"])
export const wadMul = (a: bigint, b: bigint) => (a * b) / BigInt(1e18)

CompoundLiquidations.LiquidateCompound.handler(async ({ event, context }) => {
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

    const exchangeRate = await getContract({ abi, address: event.params.cTokenCollateral as Hex, client: clients[event.chainId] }).read.exchangeRateCurrent({ blockNumber: BigInt(event.block.number) })

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
      chainId: event.chainId,
      contangoPositionId: positionId,
      collateralDelta: -wadMul(event.params.seizeTokens, exchangeRate),
      debtDelta: -event.params.repayAmount,
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