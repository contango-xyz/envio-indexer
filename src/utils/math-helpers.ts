// ----------   Math helpers   ---------- //

export const absolute = (value: bigint) => (value > 0 ? value : value * -1n)
export const mulDiv = (a: bigint, b: bigint, c: bigint, rounding: "up" | "down" = "down"): bigint => {
  const numerator = a * b

  if (!numerator || !c) {
    // Return 0n if numerator or c is 0n
    return 0n
  }

  if (rounding === "down") {
    // Rounding down (floor division)
    return numerator / c
  } else {
    // Rounding up (ceiling division)
    return (numerator + c - 1n) / c
  }
}

export const min = (a: bigint, b: bigint) => (a < b ? a : b)
export const max = (a: bigint, b: bigint) => (a > b ? a : b)
