namespace Loupedeck.MeetingKeysPlugin
{
    using System;

    // One command with 9 parameters "0".."8", one per MX Keypad key.
    // Draws whatever the app sent for that slot and reports presses back to the app.
    public class KeySlotCommand : PluginDynamicCommand
    {
        private static readonly String[] Positions =
        {
            "top left", "top middle", "top right",
            "middle left", "middle middle", "middle right",
            "bottom left", "bottom middle", "bottom right",
        };

        private static readonly BitmapColor AlertBg = new(0xE5, 0x48, 0x4D);
        private static readonly BitmapColor SeenText = new(0x9A, 0x9A, 0x9A);
        private static readonly BitmapColor SubText = new(0xC8, 0xC8, 0xC8);
        private static readonly BitmapColor SeenSubText = new(0x70, 0x70, 0x70);

        private const Int32 BorderWidth = 4;
        private const Double LabelAreaShare = 0.7;

        public KeySlotCommand()
            : base()
        {
            for (var i = 0; i < KeyState.SlotCount; i++)
            {
                this.AddParameter(i.ToString(), $"Slot {i} ({Positions[i]})", "Meeting Keys");
            }
        }

        private MeetingKeysPlugin MeetingPlugin => (MeetingKeysPlugin)this.Plugin;

        protected override Boolean OnLoad()
        {
            this.MeetingPlugin.Keys.SlotChanged += this.OnSlotChanged;
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

            if (!TryParseSlot(actionParameter, out var slot))
            {
                b.Clear(BitmapColor.Black);
                return b.ToImage();
            }

            var keys = this.MeetingPlugin.Keys;
            if (!keys.Connected)
            {
                PluginLog.Info($"Draw slot {slot}: disconnected{(slot == KeyStore.NoAppSlot ? " label=No app" : "")}");
                b.Clear(BitmapColor.Black);
                if (slot == KeyStore.NoAppSlot)
                {
                    b.DrawText("No app", BitmapColor.White);
                }

                return b.ToImage();
            }

            var s = keys.Get(slot);
            PluginLog.Info($"Draw slot {slot}: state={s.State} label={s.Label.Replace("\n", "\\n")}");

            var bg = ParseHex(s.Bg);
            var label = s.Label;
            var textColor = BitmapColor.White;
            var subColor = SubText;

            switch (s.State)
            {
                case "empty":
                    b.Clear(BitmapColor.Black);
                    return b.ToImage();
                case "seen":
                    bg = Dim(bg, 0.4);
                    textColor = SeenText;
                    subColor = SeenSubText;
                    break;
                case "busy":
                    label += "…";
                    break;
                case "alert":
                    bg = AlertBg;
                    break;
                default:
                    // "new" and "shown" use bg + white label; "new" adds a border below.
                    break;
            }

            b.Clear(bg);

            if (String.IsNullOrEmpty(s.Sub))
            {
                b.DrawText(label, textColor);
            }
            else
            {
                var labelHeight = (Int32)(b.Height * LabelAreaShare);
                b.DrawText(label, 0, 0, b.Width, labelHeight, textColor);
                b.DrawText(s.Sub, 0, labelHeight, b.Width, b.Height - labelHeight, subColor);
            }

            if (s.State == "new")
            {
                for (var i = 0; i < BorderWidth; i++)
                {
                    b.DrawRectangle(i, i, b.Width - 1 - (2 * i), b.Height - 1 - (2 * i), BitmapColor.White);
                }
            }

            return b.ToImage();
        }

        private static Boolean TryParseSlot(String actionParameter, out Int32 slot) =>
            Int32.TryParse(actionParameter, out slot) && slot >= 0 && slot < KeyState.SlotCount;

        // "#RRGGBB" -> colour; anything else -> black.
        private static BitmapColor ParseHex(String hex)
        {
            if (hex != null && hex.Length == 7 && hex[0] == '#'
                && Int32.TryParse(hex.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out var rgb))
            {
                return new BitmapColor((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
            }

            return BitmapColor.Black;
        }

        private static BitmapColor Dim(BitmapColor c, Double factor) =>
            new((Int32)(c.R * factor), (Int32)(c.G * factor), (Int32)(c.B * factor));
    }
}
