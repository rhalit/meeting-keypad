namespace Loupedeck.MeetingKeysPlugin
{
    using System;
    using System.Collections.Generic;

    // Thread-safe per-slot state. Written by the WebSocket thread, read by GetCommandImage.
    public sealed class KeyStore
    {
        // Slot whose key shows "No app" while the app is unreachable.
        public const Int32 NoAppSlot = 4;

        private readonly Object _lock = new();
        private readonly KeyState[] _slots = new KeyState[KeyState.SlotCount];
        private Boolean _connected;

        public KeyStore()
        {
            for (var i = 0; i < KeyState.SlotCount; i++)
            {
                this._slots[i] = KeyState.Empty(i);
            }
        }

        // Fired once per slot whose drawing changed. May fire on a background thread.
        public event Action<Int32> SlotChanged;

        public Boolean Connected
        {
            get
            {
                lock (this._lock)
                {
                    return this._connected;
                }
            }
        }

        public KeyState Get(Int32 slot)
        {
            lock (this._lock)
            {
                return this._slots[slot];
            }
        }

        public void Apply(IEnumerable<KeyState> states)
        {
            var changed = new List<Int32>();
            lock (this._lock)
            {
                foreach (var state in states)
                {
                    if (state.Slot < 0 || state.Slot >= KeyState.SlotCount)
                    {
                        continue;
                    }

                    if (!this._slots[state.Slot].Equals(state))
                    {
                        this._slots[state.Slot] = state;
                        if (!changed.Contains(state.Slot))
                        {
                            changed.Add(state.Slot);
                        }
                    }
                }
            }

            this.Raise(changed);
        }

        public void SetConnected(Boolean connected)
        {
            var changed = new List<Int32>();
            lock (this._lock)
            {
                if (this._connected == connected)
                {
                    return;
                }

                this._connected = connected;
                if (connected)
                {
                    // Only the "No app" key looks different; the rest stay blank until "keys" arrives.
                    changed.Add(NoAppSlot);
                }
                else
                {
                    for (var i = 0; i < KeyState.SlotCount; i++)
                    {
                        this._slots[i] = KeyState.Empty(i);
                        changed.Add(i);
                    }
                }
            }

            this.Raise(changed);
        }

        private void Raise(List<Int32> slots)
        {
            var handler = this.SlotChanged;
            if (handler == null)
            {
                return;
            }

            foreach (var slot in slots)
            {
                try
                {
                    handler(slot);
                }
                catch (Exception ex)
                {
                    PluginLog.Error(ex, $"SlotChanged handler failed for slot {slot}");
                }
            }
        }
    }
}
