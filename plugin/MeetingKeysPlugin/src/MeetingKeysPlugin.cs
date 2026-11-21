namespace Loupedeck.MeetingKeysPlugin
{
    using System;

    // Plugin-level logic: owns the key state and the connection to the app.
    // The plugin stays dumb: it draws what the app sends and reports key presses.

    public class MeetingKeysPlugin : Plugin
    {
        // Gets a value indicating whether this is an API-only plugin.
        public override Boolean UsesApplicationApiOnly => true;

        // Gets a value indicating whether this is a Universal plugin or an Application plugin.
        public override Boolean HasNoApplication => true;

        // Per-slot state as last sent by the app.
        public KeyStore Keys { get; } = new KeyStore();

        // Background WebSocket client to ws://127.0.0.1:8765.
        public AppConnection Connection { get; private set; }

        // Initializes a new instance of the plugin class.
        public MeetingKeysPlugin()
        {
            // Initialize the plugin log.
            PluginLog.Init(this.Log);

            // Initialize the plugin resources.
            PluginResources.Init(this.Assembly);
        }

        // This method is called when the plugin is loaded.
        public override void Load()
        {
            this.Connection = new AppConnection(this.Keys);
            this.Connection.Start();
        }

        // This method is called when the plugin is unloaded.
        public override void Unload()
        {
            this.Connection?.Stop();
        }
    }
}
