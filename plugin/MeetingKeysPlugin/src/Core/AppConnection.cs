namespace Loupedeck.MeetingKeysPlugin
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Net.WebSockets;
    using System.Text;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    // WebSocket client to the app (protocol/messages.md). Runs entirely on background tasks
    // so it never blocks the Logi Plugin Service.
    public sealed class AppConnection
    {
        private static readonly Uri AppUri = new("ws://127.0.0.1:8765");
        private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(2);
        private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(2);
        private const String PluginVersion = "0.1.0";

        private readonly KeyStore _store;
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private CancellationTokenSource _cts;
        private Task _loop;
        private volatile ClientWebSocket _socket;

        public AppConnection(KeyStore store)
        {
            this._store = store;
        }

        public void Start()
        {
            if (this._loop != null)
            {
                return;
            }

            this._cts = new CancellationTokenSource();
            var token = this._cts.Token;
            this._loop = Task.Run(() => this.RunLoopAsync(token));
            PluginLog.Info($"AppConnection started, connecting to {AppUri}");
        }

        public void Stop()
        {
            if (this._cts == null)
            {
                return;
            }

            this._cts.Cancel();
            try
            {
                this._socket?.Abort();
            }
            catch (Exception)
            {
                // Ignore errors while shutting down.
            }

            this._cts.Dispose();
            this._cts = null;
            this._loop = null;
            PluginLog.Info("AppConnection stopped");
        }

        // Called from RunCommand: fire and forget so the service thread never waits on the network.
        public void TrySendPress(Int32 slot)
        {
            var socket = this._socket;
            if (socket == null || socket.State != WebSocketState.Open)
            {
                PluginLog.Info($"Press on slot {slot} dropped: not connected");
                return;
            }

            var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var json = $"{{\"type\":\"press\",\"slot\":{slot},\"ts\":{ts}}}";
            _ = this.SendAsync(socket, json, CancellationToken.None);
        }

        private async Task RunLoopAsync(CancellationToken ct)
        {
            var failureLogged = false;

            while (!ct.IsCancellationRequested)
            {
                using var socket = new ClientWebSocket();
                var connected = false;
                try
                {
                    using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
                    {
                        connectCts.CancelAfter(ConnectTimeout);
                        await socket.ConnectAsync(AppUri, connectCts.Token).ConfigureAwait(false);
                    }

                    connected = true;
                    failureLogged = false;
                    this._socket = socket;
                    PluginLog.Info($"Connected to app at {AppUri}");
                    this._store.SetConnected(true);

                    await this.SendAsync(
                        socket,
                        $"{{\"type\":\"hello\",\"plugin\":\"MeetingKeys\",\"version\":\"{PluginVersion}\"}}",
                        ct).ConfigureAwait(false);

                    await this.ReceiveLoopAsync(socket, ct).ConfigureAwait(false);
                    PluginLog.Info($"Disconnected from app (closed: {socket.CloseStatus} {socket.CloseStatusDescription})");
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    if (connected)
                    {
                        PluginLog.Info($"Disconnected from app ({ex.GetType().Name}: {ex.Message})");
                    }
                    else if (!failureLogged)
                    {
                        PluginLog.Info($"App not reachable at {AppUri} ({ex.Message}); retrying every {RetryDelay.TotalSeconds:0} s");
                        failureLogged = true;
                    }
                }
                finally
                {
                    this._socket = null;
                    this._store.SetConnected(false);
                }

                try
                {
                    await Task.Delay(RetryDelay, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken ct)
        {
            var buffer = new Byte[8192];
            using var message = new MemoryStream();

            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(new ArraySegment<Byte>(buffer), ct).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }

                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage)
                {
                    continue;
                }

                var text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (Int32)message.Length);
                message.SetLength(0);

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    this.HandleMessage(text);
                }
            }
        }

        private void HandleMessage(String text)
        {
            PluginLog.Info($"Received: {(text.Length > 500 ? text.Substring(0, 500) + "..." : text)}");

            try
            {
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;

                if (type != "keys")
                {
                    PluginLog.Warning($"Ignoring message of unknown type '{type}'");
                    return;
                }

                if (!root.TryGetProperty("keys", out var keys) || keys.ValueKind != JsonValueKind.Array)
                {
                    PluginLog.Warning("Ignoring 'keys' message without a keys array");
                    return;
                }

                var states = new List<KeyState>();
                foreach (var k in keys.EnumerateArray())
                {
                    if (!k.TryGetProperty("slot", out var slotEl) || !slotEl.TryGetInt32(out var slot)
                        || slot < 0 || slot >= KeyState.SlotCount)
                    {
                        PluginLog.Warning($"Ignoring key with missing or invalid slot: {k.GetRawText()}");
                        continue;
                    }

                    states.Add(new KeyState(
                        slot,
                        GetString(k, "label") ?? "",
                        GetString(k, "sub"),
                        GetString(k, "bg") ?? "#000000",
                        GetString(k, "state") ?? "shown"));
                }

                this._store.Apply(states);
            }
            catch (JsonException ex)
            {
                PluginLog.Warning($"Ignoring invalid JSON: {ex.Message}");
            }
        }

        private static String GetString(JsonElement el, String name) =>
            el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private async Task SendAsync(ClientWebSocket socket, String json, CancellationToken ct)
        {
            await this._sendLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (socket.State != WebSocketState.Open)
                {
                    return;
                }

                var bytes = Encoding.UTF8.GetBytes(json);
                await socket.SendAsync(new ArraySegment<Byte>(bytes), WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
                PluginLog.Info($"Sent: {json}");
            }
            catch (Exception ex)
            {
                PluginLog.Warning($"Send failed: {ex.Message}");
            }
            finally
            {
                this._sendLock.Release();
            }
        }
    }
}
