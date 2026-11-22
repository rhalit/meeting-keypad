namespace Loupedeck.MeetingKeysPlugin
{
    using System;

    // What one key should show, as sent by the app (protocol/messages.md, v2).
    // Label = the full term or action name (the plugin fits it), Sub = category (term keys only),
    // Color = "#RRGGBB" category colour, or the label colour on keys without a category.
    // Records compare by value, so KeyStore can detect real changes.
    public sealed record KeyState(Int32 Slot, String Label, String Sub, String Color, String State)
    {
        public const Int32 SlotCount = 9;

        public static KeyState Empty(Int32 slot) => new(slot, "", null, null, "empty");
    }
}
