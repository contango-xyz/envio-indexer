import { fromHex } from "viem"
import { Hex } from "viem"

export const positionIdMapper = (positionId: Hex) => {
  const symbolHex = positionId.substring(0, 34) as Hex
  const symbol = fromHex(symbolHex, { size: 32, to: "string" })
  const mm = Number(`0x${positionId.substring(34, 36)}`)
  const maturity = Number(`0x${positionId.substring(36, 44)}`)
  const payload: Hex = `0x${positionId.substring(44, 54)}`
  const number = Number(`0x${positionId.substring(54)}`)
  return {
    symbol,
    mm,
    number,
    positionId,
    maturity,
    symbolHex,
    payload,
  }
}
