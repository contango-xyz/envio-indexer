import { ERC20, ERC20_Transfer_event, FillItem, Position, WETH, handlerContext } from "generated";
import { processEvents } from "./ContangoProxy";
import { erc20EventStore, eventStore } from "./Store";
import { getPairForPositionId } from "./utils/common";
import { mulDiv } from "./utils/math-helpers";

const vaultProxy = "0x3f37c7d8e61c000085aac0515775b06a3412f36b"
const contangoProxy = "0x6cae28b3d09d8f8fc74ccd496ac986fc84c0c24e"

const TRADER = '0x0000000000000000000000000000000000000001'

export const filterERC20TransferEvents = (event: ERC20_Transfer_event, position: Position) => {
  const [from, to, owner] = [event.params.from.toLowerCase(), event.params.to.toLowerCase(), position.owner.toLowerCase()]
  return (to === vaultProxy && from === owner) || (to === contangoProxy && from === vaultProxy)
}

export const updateFillItemWithCashflowEvents = async ({ event, context, position, fillItem }: { fillItem: FillItem, position: Position, event: ERC20_Transfer_event, context: handlerContext }) => {
  const { collateralToken, debtToken } = await getPairForPositionId({ chainId: event.chainId, positionId: fillItem.positionId, context: context })
  const newFillItem = { ...fillItem }

  const [from, to, owner, srcAddress] = [event.params.from, event.params.to, position.owner, event.srcAddress].map(a => a.toLowerCase())

  const isDeposit = to === vaultProxy && [owner, TRADER].includes(from)
  const isWithdrawal = from === vaultProxy && [owner, TRADER].includes(to)
  let cashflowQuote = 0n
  let cashflowBase = 0n

  if (isDeposit) {
    if (debtToken.address === srcAddress) cashflowQuote = event.params.value
    if (collateralToken.address === srcAddress) cashflowBase = event.params.value
  } else if (isWithdrawal) {
    if (debtToken.address === srcAddress) cashflowQuote = -event.params.value
    if (collateralToken.address === srcAddress) cashflowBase = -event.params.value
    // if we reach here, it means the deposit is of a different token, aka alternative cashflow
    // but it's fine, we'll also get a transfer to vault on the output of the swap. 
  }

  newFillItem.cashflowQuote += cashflowQuote || mulDiv(cashflowBase, newFillItem.tradePrice_long, collateralToken.unit)
  newFillItem.cashflowBase += cashflowBase || mulDiv(cashflowQuote, collateralToken.unit, newFillItem.tradePrice_long)

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

WETH.Deposit.handler(async ({ event }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: TRADER,
      to: event.params.dst,
      value: event.params.wad
    }
  }
  erc20EventStore.addLog({ chainId: event.chainId, transactionHash: event.transaction.hash, erc20Event })
},
{
  wildcard: true,
  eventFilters: [
    { dst: contangoProxy }
  ]
})

WETH.Withdrawal.handler(async ({ event, context }) => {
  if (!event.transaction.from) throw new Error('No from address on transaction')
  const erc20Event: ERC20_Transfer_event = {
    ...event,
    params: {
      from: event.params.src,
      to: TRADER,
      value: event.params.wad
    }
  }

  erc20EventStore.addLog({ chainId: event.chainId, transactionHash: event.transaction.hash, erc20Event })

  const position = eventStore.getCurrentPosition({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash })
  if (position) {
    await processEvents({ event: { ...event, blockNumber: event.block.number, transactionHash: event.transaction.hash, blockTimestamp: event.block.timestamp, positionId: position.positionId }, context })
  }
},
{
  wildcard: true,
  eventFilters: [
    { src: vaultProxy }
  ]
})
