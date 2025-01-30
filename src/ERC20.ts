import { ERC20, ERC20_Transfer_event, FillItem, Position, handlerContext } from "generated";
import { erc20EventStore } from "./Store";
import { getPairForPositionId } from "./utils/common";
import { mulDiv } from "./utils/math-helpers";

const vaultProxy = "0x3f37c7d8e61c000085aac0515775b06a3412f36b"
const contangoProxy = "0x6cae28b3d09d8f8fc74ccd496ac986fc84c0c24e"

export const updateFillItemWithCashflowEvents = async ({ event, context, position, fillItem }: { fillItem: FillItem, position: Position, event: ERC20_Transfer_event, context: handlerContext }) => {
  const pair = await getPairForPositionId({ chainId: event.chainId, positionId: position.positionId, context })
  const { collateralToken } = await getPairForPositionId({ chainId: event.chainId, positionId: fillItem.positionId, context: context })
  const newFillItem = { ...fillItem }

  const srcAddress = event.srcAddress.toLowerCase()
  const [to, from] = [event.params.to.toLowerCase(), event.params.from.toLowerCase()]

  if (to === vaultProxy || (to === contangoProxy && from === vaultProxy)) {
    if (pair.debtToken.address === srcAddress) newFillItem.cashflowQuote += event.params.value
    if (pair.collateralToken.address === srcAddress) newFillItem.cashflowBase += event.params.value
    // if we reach here, it means the deposit is of a different token, aka alternative cashflow
    // but it's fine, we'll also get a transfer to vault on the output of the swap. 
  }

  if (from === vaultProxy || (from === contangoProxy && to === vaultProxy)) {
    if (pair.debtToken.address === event.srcAddress) newFillItem.cashflowQuote -= event.params.value
    if (pair.collateralToken.address === event.srcAddress) newFillItem.cashflowBase -= event.params.value
  }

  newFillItem.cashflowQuote = newFillItem.cashflowQuote || mulDiv(newFillItem.cashflowBase, newFillItem.tradePrice_long, collateralToken.unit)
  newFillItem.cashflowBase = newFillItem.cashflowBase || mulDiv(newFillItem.cashflowQuote, collateralToken.unit, newFillItem.tradePrice_long)

  return newFillItem
}

ERC20.Transfer.handler(async ({ event }) => {
  erc20EventStore.addLog({ chainId: event.chainId, transactionHash: event.transaction.hash, erc20Event: event })
},
{
  wildcard: true,
  eventFilters: [
    { to: vaultProxy },
    { from: vaultProxy },
    { from: vaultProxy, to: contangoProxy }
  ]
})

