using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace CorticoOvercooked2
{
    /// <summary>
    /// TCP server on 127.0.0.1 speaking UTF-8 JSON lines. Several clients may connect (the World
    /// and test scripts); broadcasts reach all of them, a reply only the client that asked.
    /// Requests are queued for the Unity main thread. Each client has its own writer thread; a
    /// client that falls behind loses queued state frames, never events or replies.
    /// </summary>
    internal sealed class Bridge : IDisposable
    {
        internal sealed class Client
        {
            public readonly TcpClient Tcp;
            public readonly Queue<string> Outbox = new Queue<string>();
            public string PendingState;
            public bool Closed;
            public Client(TcpClient tcp) { Tcp = tcp; }
        }

        internal struct Request
        {
            public Client From;
            public Dictionary<string, object> Frame;
        }

        private readonly TcpListener _listener;
        private readonly List<Client> _clients = new List<Client>();
        private readonly Queue<Request> _inbox = new Queue<Request>();
        private volatile bool _disposed;
        private const int MaxOutbox = 2000;

        public Bridge(int port)
        {
            _listener = new TcpListener(IPAddress.Loopback, port);
            _listener.Start();
            new Thread(AcceptLoop) { IsBackground = true, Name = "cortico-oc2-accept" }.Start();
        }

        public int ClientCount { get { lock (_clients) return _clients.Count; } }

        public bool TryDequeue(out Request request)
        {
            lock (_inbox)
            {
                if (_inbox.Count == 0) { request = default(Request); return false; }
                request = _inbox.Dequeue();
                return true;
            }
        }

        /// <summary>Queues a frame for every client.</summary>
        public void Broadcast(string json)
        {
            lock (_clients) foreach (var c in _clients) Enqueue(c, json);
        }

        /// <summary>Replaces the not yet written state frame of every client with this one.</summary>
        public void BroadcastState(string json)
        {
            lock (_clients)
            {
                foreach (var c in _clients)
                {
                    lock (c.Outbox) { c.PendingState = json; Monitor.Pulse(c.Outbox); }
                }
            }
        }

        public void Send(Client client, string json)
        {
            if (client != null) Enqueue(client, json);
        }

        private static void Enqueue(Client c, string json)
        {
            lock (c.Outbox)
            {
                if (c.Closed) return;
                if (c.Outbox.Count >= MaxOutbox) { c.Closed = true; try { c.Tcp.Close(); } catch { } }
                else c.Outbox.Enqueue(json);
                Monitor.Pulse(c.Outbox);
            }
        }

        private void AcceptLoop()
        {
            while (!_disposed)
            {
                TcpClient tcp;
                try { tcp = _listener.AcceptTcpClient(); }
                catch { if (_disposed) return; continue; }
                tcp.NoDelay = true;
                var client = new Client(tcp);
                lock (_clients) _clients.Add(client);
                lock (_inbox) _inbox.Enqueue(new Request { From = client, Frame = new Dictionary<string, object> { ["op"] = "_connected" } });
                new Thread(() => ReadLoop(client)) { IsBackground = true, Name = "cortico-oc2-read" }.Start();
                new Thread(() => WriteLoop(client)) { IsBackground = true, Name = "cortico-oc2-write" }.Start();
            }
        }

        private void ReadLoop(Client client)
        {
            try
            {
                using (var reader = new StreamReader(client.Tcp.GetStream(), new UTF8Encoding(false)))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length == 0) continue;
                        Dictionary<string, object> frame;
                        try { frame = Json.Parse(line) as Dictionary<string, object>; }
                        catch (Exception err) { Plugin.Log.LogWarning("[bridge] bad frame: " + err.Message); continue; }
                        if (frame == null) continue;
                        lock (_inbox) _inbox.Enqueue(new Request { From = client, Frame = frame });
                    }
                }
            }
            catch { }
            Drop(client);
        }

        private void WriteLoop(Client client)
        {
            try
            {
                var stream = client.Tcp.GetStream();
                var utf8 = new UTF8Encoding(false);
                while (true)
                {
                    string next;
                    lock (client.Outbox)
                    {
                        while (!client.Closed && client.Outbox.Count == 0 && client.PendingState == null) Monitor.Wait(client.Outbox);
                        if (client.Closed) return;
                        if (client.Outbox.Count > 0) next = client.Outbox.Dequeue();
                        else { next = client.PendingState; client.PendingState = null; }
                    }
                    var bytes = utf8.GetBytes(next + "\n");
                    stream.Write(bytes, 0, bytes.Length);
                }
            }
            catch { }
            Drop(client);
        }

        private void Drop(Client client)
        {
            lock (client.Outbox) { client.Closed = true; Monitor.Pulse(client.Outbox); }
            try { client.Tcp.Close(); } catch { }
            bool removed;
            lock (_clients) removed = _clients.Remove(client);
            if (removed) lock (_inbox) _inbox.Enqueue(new Request { From = client, Frame = new Dictionary<string, object> { ["op"] = "_disconnected" } });
        }

        public void Dispose()
        {
            _disposed = true;
            try { _listener.Stop(); } catch { }
            List<Client> all;
            lock (_clients) all = new List<Client>(_clients);
            foreach (var c in all) Drop(c);
        }
    }
}
