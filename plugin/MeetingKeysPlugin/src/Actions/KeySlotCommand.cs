namespace Loupedeck.MeetingKeysPlugin
{
    using System;

    // One command with 9 parameters "0".."8", one per MX Keypad key.
    // Draws whatever the app sent for that slot and reports presses back to the app.
    //
    // Key look (protocol/messages.md, v2): black background; on term keys the category in small capitals
    // at the top in the category colour, and the full term large, bold, white and centred in up to 2 lines
    // (TextFit picks the size). Bottom-row keys: the label centred, no category.
    public class KeySlotCommand : PluginDynamicCommand
    {
        private static readonly String[] Positions =
        {
            "top left", "top middle", "top right",
            "middle left", "middle middle", "middle right",
            "bottom left", "bottom middle", "bottom right",
        };

        // The service's own font family (embedded in PluginApi.dll); TextFit's widths are this font's.
        private const String TermFont = "Brown Logitech Pan Bold";

        private static readonly BitmapColor Background = BitmapColor.Black;
        private static readonly BitmapColor AlertBg = new(0xE5, 0x48, 0x4D);
        private static readonly BitmapColor SeenText = new(0x50, 0x57, 0x60); // dark enough to read as "opened" on the LCD
        private static readonly BitmapColor DefaultAccent = new(0x8B, 0x94, 0x9E);

        private const Int32 BorderWidth = 2;

        // Layout, as shares of the key height.
        private const Double Pad = 0.06;
        private const Double CategoryBand = 0.22;
        private const Double CategorySize = 0.12;
        private const Double TermMaxSize = 0.30;
        private const Double ActionMaxSize = 0.24;
        private const Double TermMinSize = 0.13;

        // Widths are estimates (no measuring API): keep this much of the box free.
        private const Double WidthSafety = 0.92;

        public KeySlotCommand()
            : base()
        {
            for (var i = 0; i < KeyState.SlotCount; i++)
            {
                this.AddParameter(i.ToString(), $"Slot {i} ({Positions[i]})", "Meeting Keys");
            }

            // A widget's image fills the whole key: the device does not print the action name under it.
            this.IsWidget = true;
        }

        private MeetingKeysPlugin MeetingPlugin => (MeetingKeysPlugin)this.Plugin;

        protected override Boolean OnLoad()
        {
            this.MeetingPlugin.Keys.SlotChanged += this.OnSlotChanged;
            PluginLog.Info($"KeySlotCommand loaded (IsWidget={this.IsWidget})");
            return true;
        }

        protected override Boolean OnUnload()
        {
            this.MeetingPlugin.Keys.SlotChanged -= this.OnSlotChanged;
            return true;
        }

        // Fires on the WebSocket thread, i.e. off the service's main thread.
        private void OnSlotChanged(Int32 slot) => this.ActionImageChanged(slot.ToString());

        protected override void RunCommand(String actionParameter)
        {
            if (!TryParseSlot(actionParameter, out var slot))
            {
                PluginLog.Warning($"RunCommand with invalid parameter '{actionParameter}'");
                return;
            }

            PluginLog.Info($"Key pressed: slot {slot}");
            this.MeetingPlugin.Connection?.TrySendPress(slot);
        }

        protected override String GetCommandDisplayName(String actionParameter, PluginImageSize imageSize)
        {
            if (!TryParseSlot(actionParameter, out var slot))
            {
                return "Meeting key";
            }

            var state = this.MeetingPlugin.Keys.Get(slot);
            return state.State == "empty" || String.IsNullOrEmpty(state.Label)
                ? $"Slot {slot}"
                : state.Label.Replace("\n", " ");
        }

        protected override BitmapImage GetCommandImage(String actionParameter, PluginImageSize imageSize)
        {
            using var b = new BitmapBuilder(imageSize);
            b.Clear(Background);

            if (!TryParseSlot(actionParameter, out var slot))
            {
                return b.ToImage();
            }

            var keys = this.MeetingPlugin.Keys;
            if (!keys.Connected)
            {
                PluginLog.Info($"Draw slot {slot}: disconnected{(slot == KeyStore.NoAppSlot ? " label=No app" : "")}");
                if (slot == KeyStore.NoAppSlot)
                {
                    this.DrawLabel(b, "No app", BitmapColor.White, top: 0, ActionMaxSize, out _);
                }

                return b.ToImage();
            }

            var s = keys.Get(slot);
            if (s.State == "empty")
            {
                PluginLog.Info($"Draw slot {slot}: state=empty");
                return b.ToImage();
            }

            var accent = ParseHex(s.Color) ?? DefaultAccent;
            var hasCategory = !String.IsNullOrEmpty(s.Sub);
            var label = s.Label ?? "";
            var textColor = hasCategory ? BitmapColor.White : (ParseHex(s.Color) ?? BitmapColor.White);
            var categoryColor = accent;

            switch (s.State)
            {
                case "seen":
                    textColor = SeenText;
                    categoryColor = Dim(accent, 0.5);
                    break;
                case "busy":
                    label += TextFit.Ellipsis;
                    break;
                case "alert":
                    b.Clear(AlertBg);
                    textColor = BitmapColor.White;
                    categoryColor = BitmapColor.White;
                    break;
            }

            var top = 0;
            if (hasCategory)
            {
                top = this.DrawCategory(b, s.Sub.ToUpperInvariant(), categoryColor);
            }

            this.DrawLabel(b, label, textColor, top, hasCategory ? TermMaxSize : ActionMaxSize, out var fit);

            if (s.State == "new")
            {
                for (var i = 0; i < BorderWidth; i++)
                {
                    b.DrawRectangle(i, i, b.Width - 1 - (2 * i), b.Height - 1 - (2 * i), accent);
                }
            }

            PluginLog.Info(
                $"Draw slot {slot}: state={s.State} label={label.Replace("\n", "\\n")} sub={s.Sub ?? "-"} " +
                $"{b.Width}x{b.Height} font {fit.FontSize}px lines=[{String.Join(" | ", fit.Lines)}]{(fit.Abbreviated ? " abbreviated" : "")}");
            return b.ToImage();
        }

        // Category in small capitals at the top; returns the y where the term area starts.
        private Int32 DrawCategory(BitmapBuilder b, String text, BitmapColor color)
        {
            var pad = (Int32)Math.Round(b.Height * Pad);
            var band = (Int32)Math.Round(b.Height * CategoryBand);
            var size = Math.Max(7, (Int32)Math.Round(b.Height * CategorySize));
            var width = b.Width - (2 * pad);
            var fit = TextFit.Fit(text, (Int32)(width * WidthSafety), band, size, Math.Max(6, size - 4));
            var line = fit.Lines.Count > 0 ? fit.Lines[0] : text;
            var y = pad / 2;
            b.DrawText(line, pad, y, width, band - y, color, fit.FontSize, fit.LineHeight, -1, TermFont);
            return band;
        }

        // The label centred in the area below `top`: up to 2 lines at the largest size that fits.
        private void DrawLabel(BitmapBuilder b, String text, BitmapColor color, Int32 top, Double maxShare, out TextFit.Result fit)
        {
            var pad = (Int32)Math.Round(b.Height * Pad);
            var y0 = Math.Max(top, pad);
            var areaH = b.Height - y0 - pad;
            var width = b.Width - (2 * pad);
            var maxSize = Math.Max(8, (Int32)Math.Round(b.Height * maxShare));
            var minSize = Math.Max(7, (Int32)Math.Round(b.Height * TermMinSize));
            fit = TextFit.Fit(text, (Int32)(width * WidthSafety), areaH, maxSize, minSize);
            var total = fit.Lines.Count * fit.LineHeight;
            var y = y0 + Math.Max(0, (areaH - total) / 2);
            foreach (var line in fit.Lines)
            {
                b.DrawText(line, pad, y, width, fit.LineHeight, color, fit.FontSize, fit.LineHeight, -1, TermFont);
                y += fit.LineHeight;
            }
        }

        private static Boolean TryParseSlot(String actionParameter, out Int32 slot) =>
            Int32.TryParse(actionParameter, out slot) && slot >= 0 && slot < KeyState.SlotCount;

        // "#RRGGBB" -> colour; anything else -> null.
        private static BitmapColor? ParseHex(String hex)
        {
            if (hex != null && hex.Length == 7 && hex[0] == '#'
                && Int32.TryParse(hex.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out var rgb))
            {
                return new BitmapColor((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
            }

            return null;
        }

        private static BitmapColor Dim(BitmapColor c, Double factor) =>
            new((Int32)(c.R * factor), (Int32)(c.G * factor), (Int32)(c.B * factor));
    }
}
