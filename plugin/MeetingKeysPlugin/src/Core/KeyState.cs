namespace Loupedeck.MeetingKeysPlugin
{
    using System;

    // What one key should show, as sent by the app (see protocol/messages.md).
    // Records compare by value, so KeyStore can detect real changes.
    public sealed record KeyState(Int32 Slot, String Label, String Sub, String Bg, String State)
    {
        public const Int32 SlotCount = 9;

        public static KeyState Empty(Int32 slot) => new(slot, "", null, "#000000", "empty");
    }
}
