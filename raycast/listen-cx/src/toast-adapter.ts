import type { MutableToast, ToastStyle } from "./workflow";

export interface ExternalToastLike<Style> {
  style: Style;
  title: string;
  message?: string;
}

export function adaptToast<Style>(
  toast: ExternalToastLike<Style>,
  initialStyle: ToastStyle,
  mapStyle: (style: ToastStyle) => Style,
): MutableToast {
  let style = initialStyle;
  return {
    get style() {
      return style;
    },
    set style(value) {
      style = value;
      toast.style = mapStyle(value);
    },
    get title() {
      return toast.title;
    },
    set title(value) {
      toast.title = value;
    },
    get message() {
      return toast.message;
    },
    set message(value) {
      toast.message = value;
    },
  };
}
