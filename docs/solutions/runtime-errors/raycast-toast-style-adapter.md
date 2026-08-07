---
title: Raycast toast styles must cross an enum adapter
date: 2026-08-07
category: runtime-errors
module: raycast-listen-cx
problem_type: runtime_error
component: tooling
symptoms:
  - "A successful Raycast command ends with: The data couldn’t be read because it isn’t in the correct format."
  - The extension reports an unhandled rejection after its network request succeeds.
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [raycast, toast, enum, runtime-adapter, typescript]
---

# Raycast toast styles must cross an enum adapter

## Problem

The listen.cx Raycast command completed its request but failed when it changed a toast from loading to success. The workflow used string style names while the Raycast API expected its own `Toast.Style` enum values.

## Symptoms

- The command showed “The data couldn’t be read because it isn’t in the correct format.”
- The link request succeeded, but the extension logged an unhandled rejection while updating the toast.

## What Didn't Work

- Casting the Raycast toast to the workflow’s structurally similar toast type only silenced TypeScript. At runtime, assigning the string `"success"` still sent the wrong value to Raycast.
- Unit tests with a plain object toast passed because they did not exercise Raycast’s enum-backed setter.

## Solution

Keep the workflow’s small string union, but map it at the Raycast boundary. `raycast/listen-cx/src/raycast-toast.ts` maps each workflow style to `Toast.Style`, while `raycast/listen-cx/src/toast-adapter.ts` forwards later mutations through that mapping.

The regression test in `raycast/listen-cx/src/toast-adapter.test.ts` verifies that changing the internal style to `"success"` writes the external enum value rather than the string.

## Why This Works

The workflow remains independent of Raycast, and the boundary adapter owns the runtime representation required by the SDK. A TypeScript cast changes no runtime value; the adapter performs the actual conversion on every style mutation.

## Prevention

- Treat SDK enums as runtime values, not structurally compatible strings.
- Test adapters with distinct fake enum values so an unmapped string assignment fails visibly.
- Verify UI-facing SDK mutations in the real Raycast runtime after unit tests pass.
