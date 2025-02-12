import { ContangoSwapEvent, FillItem, SimpleSpotExecutor, SpotExecutor, handlerContext } from "generated";
import { eventStore } from "./Store";
import { getPairForPositionId } from "./utils/common";
import { getOrCreateToken, getTokenOrThrow } from "./utils/getTokenDetails";
import { EventId, createEventId } from "./utils/ids";
import { absolute, mulDiv } from "./utils/math-helpers";
import { EventType } from "./utils/types";


export const addSwapsToFillItem = async ({ swapEvents, fillItem, context }: { swapEvents: ContangoSwapEvent[]; fillItem: FillItem; context: handlerContext }) => {
  const newFillItem = { ...fillItem }
  for (const swapEvent of swapEvents) {
    const [tokenIn, tokenOut] = await Promise.all([
      getTokenOrThrow({ id: swapEvent.tokenIn_id, context }),
      getTokenOrThrow({ id: swapEvent.tokenOut_id, context }),
    ])

    const { debtToken, collateralToken } = await getPairForPositionId({ chainId: swapEvent.chainId, positionId: fillItem.positionId, context: context })

    if (tokenIn.address === debtToken.address && tokenOut.address === collateralToken.address) {
      newFillItem.tradePrice_long = mulDiv(swapEvent.amountIn, collateralToken.unit, swapEvent.amountOut)
      newFillItem.tradePrice_short = mulDiv(swapEvent.amountOut, debtToken.unit, swapEvent.amountIn)
      break
    }

    if (tokenIn.address === collateralToken.address && tokenOut.address === debtToken.address) {
      newFillItem.tradePrice_long = mulDiv(swapEvent.amountOut, collateralToken.unit, swapEvent.amountIn)
      newFillItem.tradePrice_short = mulDiv(swapEvent.amountIn, debtToken.unit, swapEvent.amountOut)
      break
    }

    newFillItem.cashflowSwap_id = swapEvent.id
  }

  return newFillItem
}

const addSwapToFillItem = async ({ swapEvent, context }: { swapEvent: ContangoSwapEvent; context: handlerContext }) => {
  const fillItem = await context.FillItem.get(swapEvent.id)
  if (fillItem) {
    // if we're in this block, it means we're processing a cashflow swap after the position was upserted 
    const updatedFillItem = await addSwapsToFillItem({ swapEvents: [swapEvent], fillItem, context })
    context.FillItem.set(updatedFillItem)
  } else {
    eventStore.addLog({
      eventId: swapEvent.id as EventId,
      contangoEvent: swapEvent
    })
  }
}

SpotExecutor.SwapExecuted.handler(async ({ event, context }) => {
  const [tokenIn, tokenOut] = await Promise.all([
    getTokenOrThrow({ id: event.params.tokenToSell, context }),
    getTokenOrThrow({ id: event.params.tokenToBuy, context }),
  ])

  const { chainId, block: { timestamp: blockTimestamp, number: blockNumber }, transaction: { hash: transactionHash }, logIndex } = event
  const swapEvent: ContangoSwapEvent = {
    id: createEventId({ chainId, blockNumber, transactionHash, logIndex, eventType: EventType.SWAP_EXECUTED }),
    eventType: EventType.SWAP_EXECUTED,
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
  await addSwapToFillItem({ swapEvent, context })
}, { wildcard: true })

const knownToAddresses = new Set([
  '0xa64f0dbb10c473978c2efe069da207991e8e3cb3', // order manager
  '0xa6a147946facac9e0b99824870b36088764f969f', // maestro
  '0xc2462f03920d47fc5b9e2c5f0ba5d2ded058fd78', // position nft
  '0x5bdeb2152f185bf59f2de027cbb05355cc965bd', // strategy proxy
])

SimpleSpotExecutor.SwapExecuted.handler(async ({ event, context }) => {

  if (event.transaction.to &&!knownToAddresses.has(event.transaction.to.toLowerCase())) return

  const [tokenIn, tokenOut] = await Promise.all([
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToSell, context }),
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToBuy, context }),
  ])

  const eventId = createEventId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex, eventType: EventType.SWAP_EXECUTED })

  const swapEvent: ContangoSwapEvent = {
    id: eventId,
    eventType: EventType.SWAP_EXECUTED,
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
  await addSwapToFillItem({ swapEvent, context })

}, { wildcard: true })
