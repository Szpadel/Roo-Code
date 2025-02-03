/**
 * Creates a stream that can be canceled by a promise.
 * Result from promise is returned as the result of the stream.
 * All values and next values are passed through the stream.
 */
export async function* cancelableStream<T, R, N>(
	stream: AsyncGenerator<T, R, N>,
	cancel: Promise<R>,
): AsyncGenerator<T, R, N> {
	let none = Symbol()
	let next: symbol | N = none
	while (true) {
		const result: IteratorResult<T, R> = await Promise.race([
			(next == none ? stream.next() : stream.next(next as N)) as Promise<IteratorResult<T, R>>,
			cancel.then((value): IteratorResult<T, R> => ({ done: true, value })),
		])

		if (result.done) {
			return result.value as R
		} else {
			next = yield result.value as T
		}
	}
}

/**
 * Filters a stream based on a predicate.
 * Only values that pass the predicate are passed through the stream.
 * Supports type predicates to narrow down the type of yielded values.
 */
export async function* filterStream<T, R, N, F extends T>(
	stream: AsyncGenerator<T, R, N>,
	filter: (value: T) => value is F,
): AsyncGenerator<F, R, N> {
	let none = Symbol()
	let next: symbol | N = none
	while (true) {
		const result: IteratorResult<T, R> = await (next == none ? stream.next() : stream.next(next as N))
		if (result.done) {
			return result.value as R
		} else {
			if (filter(result.value)) {
				next = yield result.value
			} else {
				next = none
			}
		}
	}
}

export async function* mapStream<T, R, N>(
	stream: AsyncGenerator<T, R, N>,
	map: (value: T) => R,
): AsyncGenerator<R, R, N> {
	let none = Symbol()
	let next: symbol | N = none
	while (true) {
		const result: IteratorResult<T, R> = await (next == none ? stream.next() : stream.next(next as N))
		if (result.done) {
			return result.value as R
		} else {
			next = yield map(result.value) as R
		}
	}
}
