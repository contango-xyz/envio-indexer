import { ContangoSwapEvent, SimpleSpotExecutor, SpotExecutor } from "generated";
import { eventStore } from "./Store";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { absolute } from "./utils/math-helpers";
import { EventType } from "./utils/types";

SpotExecutor.SwapExecuted.handler(async ({ event, context }) => {
  const [tokenIn, tokenOut] = await Promise.all([
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToSell, context }),
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToBuy, context }),
  ])

  const { chainId, block: { timestamp: blockTimestamp, number: blockNumber }, transaction: { hash: transactionHash }, logIndex } = event
  const eventId = createEventId({ ...event, eventType: EventType.SWAP_EXECUTED })
  const swapEvent: ContangoSwapEvent = {
    id: eventId,
    chainId,
    tokenIn_id: tokenIn.id,
    tokenOut_id: tokenOut.id,
    amountIn: absolute(event.params.amountIn),
    amountOut: absolute(event.params.amountOut),
    blockNumber,
    blockTimestamp,
    transactionHash,
  }

  context.ContangoSwapEvent.set(swapEvent)
  eventStore.addLog({ event, contangoEvent: { ...swapEvent, eventType: EventType.SWAP_EXECUTED } })
})

SimpleSpotExecutor.SwapExecuted.handler(async ({ event, context }) => {

  const [tokenIn, tokenOut] = await Promise.all([
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToSell, context }),
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToBuy, context }),
  ])

  const eventId = createEventId({ ...event, eventType: EventType.SWAP_EXECUTED })

  const swapEvent: ContangoSwapEvent = {
    id: eventId,
    chainId: event.chainId,
    tokenIn_id: tokenIn.id,
    tokenOut_id: tokenOut.id,
    amountIn: absolute(event.params.amountIn),
    amountOut: absolute(event.params.amountOut),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoSwapEvent.set(swapEvent)
  eventStore.addLog({ event, contangoEvent: { ...swapEvent, eventType: EventType.SWAP_EXECUTED } })
})
