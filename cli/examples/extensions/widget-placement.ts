import type { ExtensionAPI } from "@arex-skill/disco";

export default function widgetPlacementExtension(ocsid: ExtensionAPI) {
	ocsid.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
