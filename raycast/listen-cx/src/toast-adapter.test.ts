import { describe, expect, it } from "vitest";
import { adaptToast } from "./toast-adapter";

describe("adaptToast", () => {
  it("translates workflow styles before updating an external toast", () => {
    const externalToast = {
      style: 1,
      title: "Working",
      message: undefined as string | undefined,
    };
    const toast = adaptToast(
      externalToast,
      "animated",
      (style) => ({ animated: 1, success: 2, failure: 3 })[style],
    );

    toast.style = "success";
    toast.title = "Done";
    toast.message = "Copied";

    expect(externalToast).toEqual({
      style: 2,
      title: "Done",
      message: "Copied",
    });
  });
});
