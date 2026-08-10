// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from "bun:test"
import { sanitizeBounds } from "../src/electron/browser/embedded/state"

describe("embedded browser layout", () => {
    test("clamps native layout bounds to the host window", () => {
        expect(sanitizeBounds(
            { height: 500, width: 500, x: 450, y: 150 },
            { height: 400, width: 600 },
        )).toEqual({
            height: 250,
            width: 150,
            x: 450,
            y: 150,
        })
        expect(sanitizeBounds({
            height: Number.POSITIVE_INFINITY,
            width: Number.NaN,
            x: -10,
            y: 20.4,
        })).toEqual({ height: 0, width: 0, x: 0, y: 20 })
    })
})
