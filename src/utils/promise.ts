const ongoingRequests = new Map()

export const singletonPromise = async <V>(
  key: string,
  promiseFn: () => Promise<V>,
): Promise<V> => {

  if (!ongoingRequests.has(key)) {
    // No ongoing request, create a new promise
    const promise = (async () => {
      return promiseFn()
    })()
      .then((newData) => {
        ongoingRequests.delete(key) // Clean up after saving to cache
        return newData
      })
      .catch((err) => {
        ongoingRequests.delete(key) // Clean up
        console.error(`Error in singletonPromise for key ${key}`)
        throw err
      })

    ongoingRequests.set(key, promise)
  }

  // Wait for either the ongoing or new promise to resolve
  return await ongoingRequests.get(key)
}
