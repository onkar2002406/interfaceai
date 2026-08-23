# Desktop surface — designed, not built

This directory is deliberately empty of implementation. It documents the seam a
desktop surface plugs into, and what it would take to fill it.

## Why it is a stub

The brief asks for one concrete surface implemented and a credible design for
the others. Building a second surface would have consumed the time that went
into the artifact schema, the error taxonomy and the control-transfer model —
which are the parts the brief calls load-bearing. What matters here is that the
seam is real, and it is: nothing outside `src/surface/web/` knows that the
implemented surface is a browser.

## The contract

A desktop surface implements exactly [`Surface`](../types.ts):

```ts
interface Surface {
  observe(opts?): Promise<Observation>
  act(action: Action, token: ControlToken): Promise<ActResult>
  location(): Promise<string>
  close(): Promise<void>
}
```

Everything downstream — the capability schema, the resolver, the replay
executor, the condition classifier, the escalation broker — is written against
these types and would not change.

## Why the abstraction actually fits

The vocabulary of `ElementNode` was chosen as the *intersection* of what the
browser accessibility tree, Windows UI Automation and macOS AX all expose, not
as a browser abstraction with desktop bolted on afterwards:

| `ElementNode` | Web (CDP AX) | Windows (UIA) | macOS (AX) |
|---|---|---|---|
| `role` | `AXNode.role` | `ControlType` | `AXRole` |
| `name` | accessible name | `Name` property | `AXTitle` / `AXDescription` |
| `value` | `AXNode.value` | `ValuePattern.Value` | `AXValue` |
| `states` | AX properties | `IsEnabled`, `IsOffscreen`, … | `AXEnabled`, … |
| `bounds` | `DOM.getBoxModel` | `BoundingRectangle` | `AXFrame` |
| `framePath` | frame chain | window / pane chain | window chain |
| `proximateLabels` | geometric derivation | geometric derivation | geometric derivation |
| `handle` | CDP backend node id | `IUIAutomationElement` | `AXUIElementRef` |

`proximateLabels` is the interesting row. It is computed from geometry rather
than read from the platform, precisely because legacy applications on *every*
platform fail to associate captions with fields programmatically. The same
derivation that recovers "Member ID" for an unlabelled `<input>` recovers it for
an unlabelled Win32 edit control.

## Acting

The web surface clicks by moving the mouse to a coordinate, because that is the
mechanism that survives having no clean DOM. On desktop it is the *only*
mechanism, so the port of [`browser-input.ts`](../web/browser-input.ts) is:

- `click` → `Input.dispatchMouseEvent` becomes `SendInput` / `CGEvent`
- `type` → focus by click, then synthesise key events — identical shape
- `select` → the one action the web surface performs semantically rather than by
  pixels; on desktop this is UIA's `SelectionItemPattern` or `ValuePattern`,
  which is the same idea: ask the platform to perform the control's semantic
  action

## What would need writing

1. **`UiaSurface`** (~400 lines): a UIA tree walk producing `ElementNode[]`,
   plus `SendInput` actuation. Node.js reaches UIA through `koffi`/`node-ffi` or
   a small C# sidecar; the sidecar is likely simpler and testable.
2. **A screenshot path** for evidence and for the operator handoff. `PrintWindow`
   or the Desktop Duplication API.
3. **Control transfer.** The operator console currently streams CDP screencast
   frames. On desktop this becomes a window capture stream plus synthetic input
   — the `ControlAuthority` token model, the intervention payload, and the
   resume-contract verification are unchanged, because none of them are
   browser-specific.
4. **An app profile** (`config/apps/<product>.yaml`) with that product's
   condition taxonomy. No code.

## What would need adjusting, honestly

- **`urlMatches` has no desktop analogue.** Predicates would need a
  `windowTitleMatches` sibling. The `Predicate` union is a flat discriminated
  union specifically so adding an arm is a local change.
- **Frame paths become window/pane paths.** The type is already `string[]`.
- **`domHint` is meaningless.** It is optional and only ever a tiebreak, so it
  simply goes unset — which is the test of whether it was correctly treated as a
  hint rather than a locator.
