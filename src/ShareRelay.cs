using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

/// <summary>
/// 시험 PC 에서 파일 제공 + WebSocket 방 중계.
/// TcpListener 로 0.0.0.0 에 열어서 URL ACL 없이 다른 PC 도 접속한다.
/// </summary>
public class ShareHttpServer
{
    private static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" },
        { ".js", "text/javascript; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" },
        { ".svg", "image/svg+xml" },
        { ".png", "image/png" },
        { ".ico", "image/x-icon" },
    };

    private static readonly HashSet<string> BlockedExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".ps1", ".bat", ".md",
    };

    public static void Run(string root, int port, string apiJson)
    {
        var listener = new TcpListener(IPAddress.Any, port);
        listener.Start();
        var rootFull = Path.GetFullPath(root);

        while (true)
        {
            TcpClient client;
            try
            {
                client = listener.AcceptTcpClient();
            }
            catch
            {
                break;
            }

            Task.Factory.StartNew(() => HandleTcp(client, rootFull, apiJson));
        }
    }

    private static void HandleTcp(TcpClient client, string rootFull, string apiJson)
    {
        try
        {
            client.NoDelay = true;
            var stream = client.GetStream();
            byte[] leftover;
            var raw = ReadHttpHead(stream, out leftover);
            if (string.IsNullOrEmpty(raw))
            {
                return;
            }

            string method;
            string path;
            string query;
            Dictionary<string, string> headers;
            if (!ParseRequest(raw, out method, out path, out query, out headers))
            {
                WriteHttp(stream, 400, "text/plain; charset=utf-8", "Bad Request");
                return;
            }

            path = NormalizePath(path);
            var upgrade = GetHeader(headers, "Upgrade");
            var isWs = method == "GET" &&
                (path == "/ws" || upgrade.IndexOf("websocket", StringComparison.OrdinalIgnoreCase) >= 0);

            if (isWs)
            {
                // hello 는 101 이후에만 온다. HTTP 잔여 바이트는 프레임으로 쓰지 않는다.
                if (leftover != null && leftover.Length > 0)
                {
                    Console.WriteLine("[ws] leftover " + leftover.Length + "B discarded");
                }

                Console.WriteLine("[ws] connect " + client.Client.RemoteEndPoint + " path=" + path);
                var ws = WsConn.Accept(stream, GetHeader(headers, "Sec-WebSocket-Key"), new byte[0]);
                if (ws == null)
                {
                    Console.WriteLine("[ws] upgrade failed (no Sec-WebSocket-Key)");
                    return;
                }

                ShareRelay.Handle(ws, client, stream);
                return;
            }

            if (path.StartsWith("/api/share/", StringComparison.Ordinal))
            {
                var body = ReadHttpBody(stream, headers, leftover);
                var json = ShareRelay.HandleHttp(method, path, query, body);
                WriteHttp(stream, 200, "application/json; charset=utf-8", json);
                return;
            }

            if (path == "/api/info")
            {
                WriteHttp(stream, 200, "application/json; charset=utf-8", apiJson);
                return;
            }

            if (path == "/")
            {
                path = "/index.html";
            }

            ServeFile(stream, rootFull, path);
        }
        catch (Exception ex)
        {
            Console.WriteLine("[http] " + ex.Message);
        }
        finally
        {
            try
            {
                client.Close();
            }
            catch
            {
            }
        }
    }

    private static void ServeFile(Stream stream, string rootFull, string requestPath)
    {
        var relative = requestPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        var fullPath = Path.GetFullPath(Path.Combine(rootFull, relative));
        var ext = Path.GetExtension(fullPath);

        if (!fullPath.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) ||
            BlockedExt.Contains(ext) ||
            !File.Exists(fullPath))
        {
            WriteHttp(stream, 404, "text/plain; charset=utf-8", "Not Found");
            return;
        }

        string contentType;
        if (!Mime.TryGetValue(ext, out contentType))
        {
            contentType = "application/octet-stream";
        }

        var bytes = File.ReadAllBytes(fullPath);
        WriteHttpBytes(stream, 200, contentType, bytes);
    }

    private static string ReadHttpHead(NetworkStream stream, out byte[] leftover)
    {
        leftover = new byte[0];
        var buffer = new byte[4096];
        var ms = new MemoryStream();

        while (ms.Length < 65536)
        {
            var n = stream.Read(buffer, 0, buffer.Length);
            if (n <= 0)
            {
                return null;
            }
            ms.Write(buffer, 0, n);
            var data = ms.ToArray();
            var end = IndexOfHeaderEnd(data);
            if (end < 0)
            {
                continue;
            }

            var headerLen = end + 4;
            if (data.Length > headerLen)
            {
                leftover = new byte[data.Length - headerLen];
                Buffer.BlockCopy(data, headerLen, leftover, 0, leftover.Length);
            }
            return Encoding.ASCII.GetString(data, 0, end);
        }

        return null;
    }

    private static int IndexOfHeaderEnd(byte[] data)
    {
        for (var i = 0; i + 3 < data.Length; i++)
        {
            if (data[i] == 13 && data[i + 1] == 10 && data[i + 2] == 13 && data[i + 3] == 10)
            {
                return i;
            }
        }
        return -1;
    }

    private static string NormalizePath(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return "/";
        }
        if (path.IndexOf("://", StringComparison.Ordinal) >= 0)
        {
            try
            {
                return new Uri(path).AbsolutePath;
            }
            catch
            {
            }
        }
        var q = path.IndexOf('?');
        return q >= 0 ? path.Substring(0, q) : path;
    }

    private static string ReadHttpBody(
        NetworkStream stream,
        Dictionary<string, string> headers,
        byte[] leftover)
    {
        int length;
        if (!int.TryParse(GetHeader(headers, "Content-Length"), out length) || length <= 0)
        {
            if (leftover != null && leftover.Length > 0)
            {
                return Encoding.UTF8.GetString(leftover);
            }
            return "";
        }

        if (length > 512 * 1024)
        {
            return "";
        }

        var buffer = new byte[length];
        var off = 0;
        if (leftover != null && leftover.Length > 0)
        {
            var take = leftover.Length < length ? leftover.Length : length;
            Buffer.BlockCopy(leftover, 0, buffer, 0, take);
            off = take;
        }

        while (off < length)
        {
            var n = stream.Read(buffer, off, length - off);
            if (n <= 0)
            {
                break;
            }
            off += n;
        }

        return Encoding.UTF8.GetString(buffer, 0, off);
    }

    private static bool ParseRequest(
        string raw,
        out string method,
        out string path,
        out string query,
        out Dictionary<string, string> headers)
    {
        method = "";
        path = "";
        query = "";
        headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var lines = raw.Split(new[] { "\r\n" }, StringSplitOptions.None);
        if (lines.Length == 0)
        {
            return false;
        }

        var parts = lines[0].Split(' ');
        if (parts.Length < 2)
        {
            return false;
        }

        method = parts[0].ToUpperInvariant();
        var uri = parts[1];
        var q = uri.IndexOf('?');
        path = Uri.UnescapeDataString(q >= 0 ? uri.Substring(0, q) : uri);
        query = q >= 0 ? uri.Substring(q + 1) : "";

        for (var i = 1; i < lines.Length; i++)
        {
            var colon = lines[i].IndexOf(':');
            if (colon <= 0)
            {
                continue;
            }
            var key = lines[i].Substring(0, colon).Trim();
            var value = lines[i].Substring(colon + 1).Trim();
            headers[key] = value;
        }

        return true;
    }

    private static string GetHeader(Dictionary<string, string> headers, string name)
    {
        string value;
        return headers.TryGetValue(name, out value) ? value : "";
    }

    private static void WriteHttp(Stream stream, int status, string contentType, string text)
    {
        WriteHttpBytes(stream, status, contentType, Encoding.UTF8.GetBytes(text ?? ""));
    }

    private static void WriteHttpBytes(Stream stream, int status, string contentType, byte[] body)
    {
        var reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Error";
        var head =
            "HTTP/1.1 " + status + " " + reason + "\r\n" +
            "Content-Type: " + contentType + "\r\n" +
            "Content-Length: " + body.Length + "\r\n" +
            "Connection: close\r\n" +
            "Cache-Control: no-store\r\n" +
            "\r\n";
        var headBytes = Encoding.ASCII.GetBytes(head);
        stream.Write(headBytes, 0, headBytes.Length);
        stream.Write(body, 0, body.Length);
        stream.Flush();
    }
}

public class WsConn
{
    private static readonly byte[] WsGuid =
        Encoding.ASCII.GetBytes("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");

    private readonly Stream stream;
    private readonly object sendLock = new object();
    private byte[] pending;
    private int pendingOff;

    public bool IsOpen;

    private WsConn(Stream stream, byte[] leftover)
    {
        this.stream = stream;
        IsOpen = true;
        pending = leftover;
        pendingOff = 0;
    }

    public static WsConn Accept(Stream stream, string key, byte[] leftover)
    {
        if (string.IsNullOrEmpty(key))
        {
            return null;
        }

        string accept;
        using (var sha = SHA1.Create())
        {
            var data = Encoding.ASCII.GetBytes(key.Trim());
            var concat = new byte[data.Length + WsGuid.Length];
            Buffer.BlockCopy(data, 0, concat, 0, data.Length);
            Buffer.BlockCopy(WsGuid, 0, concat, data.Length, WsGuid.Length);
            accept = Convert.ToBase64String(sha.ComputeHash(concat));
        }

        var response =
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " + accept + "\r\n" +
            "\r\n";
        var bytes = Encoding.ASCII.GetBytes(response);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
        return new WsConn(stream, leftover);
    }

    public string ReceiveText()
    {
        var message = new MemoryStream();

        while (IsOpen)
        {
            int opcode;
            byte[] payload;
            bool fin;
            if (!ReadFrame(out opcode, out payload, out fin))
            {
                IsOpen = false;
                return null;
            }

            if (opcode == 8)
            {
                IsOpen = false;
                return null;
            }
            if (opcode == 9)
            {
                SendFrame(10, payload);
                continue;
            }
            if (opcode == 10)
            {
                continue;
            }
            if (opcode != 1 && opcode != 0)
            {
                continue;
            }

            message.Write(payload, 0, payload.Length);
            if (fin)
            {
                return Encoding.UTF8.GetString(message.ToArray());
            }
        }

        return null;
    }

    public void SendText(string text)
    {
        if (!IsOpen)
        {
            return;
        }
        SendFrame(1, Encoding.UTF8.GetBytes(text ?? ""));
    }

    public void Close()
    {
        if (!IsOpen)
        {
            return;
        }
        try
        {
            SendFrame(8, new byte[0]);
        }
        catch
        {
        }
        IsOpen = false;
    }

    private bool ReadFrame(out int opcode, out byte[] payload, out bool fin)
    {
        opcode = 0;
        payload = new byte[0];
        fin = true;

        var h1 = ReadExact(2);
        if (h1 == null)
        {
            return false;
        }

        fin = (h1[0] & 0x80) != 0;
        opcode = h1[0] & 0x0F;
        var masked = (h1[1] & 0x80) != 0;
        var len = (long)(h1[1] & 0x7F);

        if (len == 126)
        {
            var ext = ReadExact(2);
            if (ext == null)
            {
                return false;
            }
            len = (ext[0] << 8) | ext[1];
        }
        else if (len == 127)
        {
            var ext = ReadExact(8);
            if (ext == null)
            {
                return false;
            }
            len = 0;
            for (var i = 0; i < 8; i++)
            {
                len = (len << 8) | ext[i];
            }
        }

        if (len < 0 || len > 1024 * 1024)
        {
            return false;
        }

        byte[] mask = null;
        if (masked)
        {
            mask = ReadExact(4);
            if (mask == null)
            {
                return false;
            }
        }

        payload = len == 0 ? new byte[0] : ReadExact((int)len);
        if (payload == null)
        {
            return false;
        }

        if (masked)
        {
            for (var i = 0; i < payload.Length; i++)
            {
                payload[i] = (byte)(payload[i] ^ mask[i % 4]);
            }
        }

        return true;
    }

    private void SendFrame(int opcode, byte[] payload)
    {
        lock (sendLock)
        {
            var len = payload.Length;
            using (var ms = new MemoryStream())
            {
                ms.WriteByte((byte)(0x80 | (opcode & 0x0F)));
                if (len <= 125)
                {
                    ms.WriteByte((byte)len);
                }
                else if (len <= 65535)
                {
                    ms.WriteByte(126);
                    ms.WriteByte((byte)((len >> 8) & 0xFF));
                    ms.WriteByte((byte)(len & 0xFF));
                }
                else
                {
                    ms.WriteByte(127);
                    for (var shift = 56; shift >= 0; shift -= 8)
                    {
                        ms.WriteByte((byte)((len >> shift) & 0xFF));
                    }
                }
                ms.Write(payload, 0, payload.Length);
                var frame = ms.ToArray();
                stream.Write(frame, 0, frame.Length);
                stream.Flush();
            }
        }
    }

    private byte[] ReadExact(int count)
    {
        var buffer = new byte[count];
        var off = 0;
        while (off < count)
        {
            if (pending != null && pendingOff < pending.Length)
            {
                var take = count - off;
                var remain = pending.Length - pendingOff;
                if (take > remain)
                {
                    take = remain;
                }
                Buffer.BlockCopy(pending, pendingOff, buffer, off, take);
                pendingOff += take;
                off += take;
                continue;
            }

            var n = stream.Read(buffer, off, count - off);
            if (n <= 0)
            {
                return null;
            }
            off += n;
        }
        return buffer;
    }
}

public class ShareRelay
{
    private static readonly object Gate = new object();
    private static readonly Dictionary<string, Room> Rooms =
        new Dictionary<string, Room>(StringComparer.Ordinal);

    public static void Handle(WsConn socket, TcpClient tcp, Stream stream)
    {
        Client client = null;
        try
        {
            try
            {
                if (tcp != null)
                {
                    tcp.ReceiveTimeout = 15000;
                }
                if (stream != null)
                {
                    stream.ReadTimeout = 15000;
                }
            }
            catch
            {
            }

            client = Handshake(socket);

            try
            {
                if (tcp != null)
                {
                    tcp.ReceiveTimeout = 0;
                }
                if (stream != null)
                {
                    stream.ReadTimeout = Timeout.Infinite;
                }
            }
            catch
            {
            }

            if (client == null)
            {
                return;
            }

            Console.WriteLine("[ws] " + client.Role + " " + client.Name);
            ReceiveLoop(client);
        }
        catch (Exception ex)
        {
            Console.WriteLine("[ws] hello failed: " + ex.GetType().Name + " " + ex.Message);
        }
        finally
        {
            if (client != null)
            {
                RemoveClient(client);
            }
            try
            {
                socket.Close();
            }
            catch
            {
            }
        }
    }

    private static Client Handshake(WsConn socket)
    {
        var raw = socket.ReceiveText();
        if (string.IsNullOrEmpty(raw))
        {
            Console.WriteLine("[ws] hello missing (no frame)");
            SendError(socket, "첫 메시지가 없습니다.");
            return null;
        }

        var msg = WireMsg.Parse(raw);
        if (msg == null)
        {
            Console.WriteLine("[ws] hello JSON failed");
            SendError(socket, "JSON 형식이 아닙니다.");
            return null;
        }

        var type = Nz(msg.type);
        var role = Nz(msg.role);
        var roomId = Nz(msg.room);
        var name = SanitizeName(Nz(msg.name), role == "host" ? "시험팀" : "게스트");

        if (type != "hello" || (role != "host" && role != "guest") || roomId.Length == 0)
        {
            Console.WriteLine("[ws] hello field error type=" + type + " role=" + role);
            SendError(socket, "hello / role / room 이 필요합니다.");
            return null;
        }

        var client = new Client
        {
            Socket = socket,
            Role = role,
            Name = name,
            RoomId = roomId,
        };

        string error = null;
        List<string> history = null;
        List<string> cmdHistory = null;
        string consolesText = null;

        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                if (role != "host")
                {
                    error = "아직 공유가 시작되지 않았습니다. 시험팀이 먼저 공유를 켜 주세요.";
                }
                else
                {
                    room = new Room();
                    Rooms[roomId] = room;
                }
            }

            if (error == null && room != null)
            {
                if (role == "host")
                {
                    if (room.Host != null && room.Host.Socket != null && room.Host.Socket.IsOpen)
                    {
                        error = "이 방의 시험팀(host)이 이미 있습니다.";
                    }
                    else
                    {
                        room.Host = client;
                    }
                }
                else if (room.Host == null || room.Host.Socket == null || !room.Host.Socket.IsOpen)
                {
                    error = "시험팀 연결이 없습니다. 공유가 꺼졌을 수 있습니다.";
                }
                else
                {
                    if (room.Guests.Count >= 20)
                    {
                        error = "이 방에 접속한 인원이 가득 찼습니다. (최대 20명)";
                    }
                    else
                    {
                        client.Name = UniqueGuestName(room, name);
                        room.Guests.Add(client);
                        history = new List<string>(room.History);
                        cmdHistory = new List<string>(room.CmdHistory);
                        consolesText = room.ConsolesText;
                    }
                }
            }
        }

        if (error != null)
        {
            Console.WriteLine("[ws] join denied " + error);
            SendError(socket, error);
            return null;
        }

        socket.SendText("{\"type\":\"welcome\"}");
        BroadcastPeers(roomId);

        if (!string.IsNullOrEmpty(consolesText))
        {
            SendJson(socket, WireMsg.Consoles(consolesText));
        }

        if (history != null)
        {
            SendHistoryItems(socket, history);
        }

        if (cmdHistory != null)
        {
            for (var i = 0; i < cmdHistory.Count; i++)
            {
                socket.SendText(cmdHistory[i]);
            }
        }

        return client;
    }

    public static string HandleHttp(string method, string path, string query, string body)
    {
        ExpireHttpGuests();

        if (path == "/api/share/hello" && method == "POST")
        {
            return HttpHello(body);
        }
        if (path == "/api/share/wait" && method == "GET")
        {
            return HttpWait(GetQueryValue(query, "sid"));
        }
        if (path == "/api/share/send" && method == "POST")
        {
            return HttpSend(body);
        }
        if (path == "/api/share/bye" && (method == "POST" || method == "GET"))
        {
            return HttpBye(GetQueryValue(query, "sid"), body);
        }

        return "{\"error\":\"알 수 없는 요청입니다.\"}";
    }

    private static string HttpHello(string body)
    {
        var msg = WireMsg.Parse(string.IsNullOrEmpty(body) ? "{}" : body);
        var roomId = msg == null ? "" : Nz(msg.room);
        var name = SanitizeName(msg == null ? "" : Nz(msg.name), "게스트");

        if (roomId.Length == 0)
        {
            return "{\"error\":\"방 토큰이 없습니다.\"}";
        }

        var sid = Guid.NewGuid().ToString("N");
        var client = new Client
        {
            Socket = null,
            Role = "guest",
            Name = name,
            RoomId = roomId,
            HttpMode = true,
            Sid = sid,
            LastSeen = DateTime.UtcNow,
        };

        string error = null;
        List<string> history = null;
        List<string> cmdHistory = null;
        string consolesText = null;

        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room) ||
                room.Host == null ||
                room.Host.Socket == null ||
                !room.Host.Socket.IsOpen)
            {
                error = "아직 공유가 시작되지 않았습니다. 시험팀이 먼저 공유를 켜 주세요.";
            }
            else
            {
                if (room.Guests.Count >= 20)
                {
                    error = "이 방에 접속한 인원이 가득 찼습니다. (최대 20명)";
                }
                else
                {
                    client.Name = UniqueGuestName(room, name);
                    room.Guests.Add(client);
                    history = new List<string>(room.History);
                    cmdHistory = new List<string>(room.CmdHistory);
                    consolesText = room.ConsolesText;
                }
            }
        }

        if (error != null)
        {
            Console.WriteLine("[share] join denied " + error);
            return "{\"error\":\"" + JsonEsc(error) + "\"}";
        }

        Console.WriteLine("[share] guest " + client.Name + " (HTTP)");
        var events = new List<string>();
        events.Add("{\"type\":\"welcome\"}");
        events.Add(PeersJson(roomId));
        if (!string.IsNullOrEmpty(consolesText))
        {
            events.Add(WireMsg.Consoles(consolesText).ToJson());
        }
        if (history != null)
        {
            AppendHistoryEvents(events, history);
        }
        if (cmdHistory != null)
        {
            for (var i = 0; i < cmdHistory.Count; i++)
            {
                events.Add(cmdHistory[i]);
            }
        }

        BroadcastPeers(roomId);
        return "{\"ok\":true,\"sid\":\"" + sid + "\",\"name\":\"" + JsonEsc(client.Name) + "\",\"events\":[" + string.Join(",", events.ToArray()) + "]}";
    }

    private static string HttpWait(string sid)
    {
        var client = FindHttpClient(sid);
        if (client == null)
        {
            return "{\"events\":[{\"type\":\"closed\",\"message\":\"시험팀이 공유를 종료했거나 연결이 끊겼습니다.\"}],\"closed\":true}";
        }

        client.LastSeen = DateTime.UtcNow;
        var jsonList = DrainHttpQueue(client);
        if (jsonList.Count == 0)
        {
            client.HttpPulse.WaitOne(10000);
            jsonList = DrainHttpQueue(client);
        }

        client.LastSeen = DateTime.UtcNow;
        if (client.HttpClosed)
        {
            return "{\"events\":[" + string.Join(",", jsonList.ToArray()) + "],\"closed\":true}";
        }

        return "{\"events\":[" + string.Join(",", jsonList.ToArray()) + "]}";
    }

    private static string HttpSend(string body)
    {
        var msg = WireMsg.Parse(string.IsNullOrEmpty(body) ? "{}" : body);
        if (msg == null)
        {
            return "{\"error\":\"JSON 형식이 아닙니다.\"}";
        }

        var sid = Nz(msg.sid);
        var client = FindHttpClient(sid);
        if (client == null)
        {
            return "{\"error\":\"세션이 없습니다. 페이지를 새로 고침하세요.\"}";
        }

        client.LastSeen = DateTime.UtcNow;
        var type = Nz(msg.type);
        if (type == "cmd")
        {
            var slot = SlotOf(msg);
            Console.WriteLine("[share] cmd " + client.Name + " " + Nz(msg.text));
            PublishCommandLog(client.RoomId, client.Name, Nz(msg.text), slot);
            SendToHost(client.RoomId, WireMsg.Cmd(Nz(msg.text), client.Name, slot));
        }
        else if (type == "cmdlog")
        {
            PublishCommandLog(client.RoomId, client.Name, Nz(msg.text), SlotOf(msg));
        }
        else if (type == "keys")
        {
            SendToHost(client.RoomId, WireMsg.Keys(Nz(msg.text), client.Name, SlotOf(msg)));
        }
        else if (type == "chat")
        {
            BroadcastAll(client.RoomId, WireMsg.Chat(Nz(msg.text), client.Name));
        }
        else if (type == "rename")
        {
            ApplyRename(client.RoomId, SlotOf(msg), Nz(msg.text));
        }

        return "{\"ok\":true}";
    }

    private static string HttpBye(string querySid, string body)
    {
        var sid = querySid;
        if (string.IsNullOrEmpty(sid))
        {
            var msg = WireMsg.Parse(string.IsNullOrEmpty(body) ? "{}" : body);
            if (msg != null)
            {
                sid = Nz(msg.sid);
            }
        }

        var client = FindHttpClient(sid);
        if (client != null)
        {
            RemoveClient(client);
        }

        return "{\"ok\":true}";
    }

    private static Client FindHttpClient(string sid)
    {
        if (string.IsNullOrEmpty(sid))
        {
            return null;
        }

        lock (Gate)
        {
            foreach (var pair in Rooms)
            {
                foreach (var guest in pair.Value.Guests)
                {
                    if (guest.HttpMode && guest.Sid == sid)
                    {
                        return guest;
                    }
                }
            }
        }

        return null;
    }

    private static void EnqueueHttp(Client client, string json)
    {
        if (client == null || !client.HttpMode || string.IsNullOrEmpty(json))
        {
            return;
        }

        lock (client.HttpLock)
        {
            client.HttpQueue.Enqueue(json);
            while (client.HttpQueue.Count > 300)
            {
                client.HttpQueue.Dequeue();
            }
        }

        try
        {
            client.HttpPulse.Set();
        }
        catch
        {
        }
    }

    private static List<string> DrainHttpQueue(Client client)
    {
        var list = new List<string>();
        lock (client.HttpLock)
        {
            while (client.HttpQueue.Count > 0)
            {
                list.Add(client.HttpQueue.Dequeue());
            }
        }
        return list;
    }

    private static string PeersJson(string roomId)
    {
        string hostName = "";
        var guestNames = new List<string>();

        lock (Gate)
        {
            Room room;
            if (Rooms.TryGetValue(roomId, out room))
            {
                if (room.Host != null)
                {
                    hostName = room.Host.Name;
                }
                foreach (var guest in room.Guests)
                {
                    guestNames.Add(guest.Name);
                }
            }
        }

        return WireMsg.Peers(hostName, guestNames.ToArray()).ToJson();
    }

    private static void ExpireHttpGuests()
    {
        var stale = new List<Client>();
        var now = DateTime.UtcNow;

        lock (Gate)
        {
            foreach (var pair in Rooms)
            {
                foreach (var guest in pair.Value.Guests)
                {
                    if (guest.HttpMode && (now - guest.LastSeen).TotalSeconds > 75)
                    {
                        stale.Add(guest);
                    }
                }
            }
        }

        foreach (var guest in stale)
        {
            Console.WriteLine("[share] guest timeout " + guest.Name);
            RemoveClient(guest);
        }
    }

    private static string SanitizeName(string value, string fallback)
    {
        var raw = Nz(value).Trim();
        var sb = new StringBuilder();
        foreach (var ch in raw)
        {
            if (ch < 32)
            {
                continue;
            }
            sb.Append(ch);
            if (sb.Length >= 20)
            {
                break;
            }
        }

        var name = sb.ToString().Trim();
        return name.Length == 0 ? fallback : name;
    }

    private static string UniqueGuestName(Room room, string wanted)
    {
        if (!GuestNameTaken(room, wanted))
        {
            return wanted;
        }

        for (var n = 2; n <= 99; n++)
        {
            var suffix = n.ToString();
            var maxBase = 20 - suffix.Length;
            if (maxBase < 1)
            {
                maxBase = 1;
            }
            var baseName = wanted.Length <= maxBase ? wanted : wanted.Substring(0, maxBase);
            var candidate = baseName + suffix;
            if (!GuestNameTaken(room, candidate))
            {
                return candidate;
            }
        }

        return wanted + Guid.NewGuid().ToString("N").Substring(0, 4);
    }

    private static bool GuestNameTaken(Room room, string name)
    {
        if (room.Host != null && string.Equals(room.Host.Name, name, StringComparison.Ordinal))
        {
            return true;
        }

        foreach (var guest in room.Guests)
        {
            if (string.Equals(guest.Name, name, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static string JsonEsc(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static string GetQueryValue(string query, string key)
    {
        if (string.IsNullOrEmpty(query) || string.IsNullOrEmpty(key))
        {
            return "";
        }

        var parts = query.Split('&');
        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i];
            var eq = part.IndexOf('=');
            var name = eq < 0 ? part : part.Substring(0, eq);
            if (!name.Equals(key, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var value = eq < 0 ? "" : part.Substring(eq + 1);
            try
            {
                return Uri.UnescapeDataString(value.Replace('+', ' '));
            }
            catch
            {
                return value;
            }
        }

        return "";
    }

    private static void ReceiveLoop(Client client)
    {
        while (client.Socket.IsOpen)
        {
            var raw = client.Socket.ReceiveText();
            if (raw == null)
            {
                break;
            }

            var msg = WireMsg.Parse(raw);
            if (msg == null)
            {
                continue;
            }

            var type = Nz(msg.type);
            if (type == "log" && client.Role == "host")
            {
                var slot = SlotOf(msg);
                RememberLog(client.RoomId, slot, Nz(msg.text));
                BroadcastToGuests(client.RoomId, WireMsg.Log(Nz(msg.text), slot));
            }
            else if (type == "cmd" && client.Role == "guest")
            {
                var slot = SlotOf(msg);
                Console.WriteLine("[ws] cmd " + client.Name + " " + Nz(msg.text));
                PublishCommandLog(client.RoomId, client.Name, Nz(msg.text), slot);
                SendToHost(client.RoomId, WireMsg.Cmd(Nz(msg.text), client.Name, slot));
            }
            else if (type == "cmdlog")
            {
                PublishCommandLog(client.RoomId, client.Name, Nz(msg.text), SlotOf(msg));
            }
            else if (type == "keys" && client.Role == "guest")
            {
                SendToHost(client.RoomId, WireMsg.Keys(Nz(msg.text), client.Name, SlotOf(msg)));
            }
            else if (type == "consoles" && client.Role == "host")
            {
                SaveConsoles(client.RoomId, Nz(msg.text));
                BroadcastToGuests(client.RoomId, WireMsg.Consoles(Nz(msg.text)));
            }
            else if (type == "chat")
            {
                BroadcastAll(client.RoomId, WireMsg.Chat(Nz(msg.text), client.Name));
            }
            else if (type == "rename")
            {
                ApplyRename(client.RoomId, SlotOf(msg), Nz(msg.text));
            }
        }
    }

    private static void SendHistoryItems(WsConn socket, List<string> history)
    {
        var raw = new StringBuilder();
        for (var i = 0; i < history.Count; i++)
        {
            var item = history[i];
            if (!string.IsNullOrEmpty(item) && item[0] == '{')
            {
                socket.SendText(item);
            }
            else
            {
                raw.Append(item);
            }
        }
        if (raw.Length > 0)
        {
            SendJson(socket, WireMsg.History(raw.ToString()));
        }
    }

    private static void AppendHistoryEvents(List<string> events, List<string> history)
    {
        var raw = new StringBuilder();
        for (var i = 0; i < history.Count; i++)
        {
            var item = history[i];
            if (!string.IsNullOrEmpty(item) && item[0] == '{')
            {
                events.Add(item);
            }
            else
            {
                raw.Append(item);
            }
        }
        if (raw.Length > 0)
        {
            events.Add(WireMsg.History(raw.ToString()).ToJson());
        }
    }

    private static void RememberLog(string roomId, string slot, string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        var json = WireMsg.Log(text, slot).ToJson();

        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }

            room.History.Add(json);
            room.HistoryBytes += text.Length;

            while (room.History.Count > 500 || (room.HistoryBytes > 400000 && room.History.Count > 0))
            {
                room.HistoryBytes -= room.History[0].Length;
                room.History.RemoveAt(0);
            }
        }
    }

    private static void SaveConsoles(string roomId, string text)
    {
        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }

            room.ConsolesText = text;
            PruneHistoryBySlots(room, SlotsInConsoles(text));
        }
    }

    private static void ApplyRename(string roomId, string slot, string title)
    {
        var clean = (title ?? "").Replace("\t", "").Replace("\n", "").Replace("\r", "").Trim();
        if (clean.Length > 20)
        {
            clean = clean.Substring(0, 20);
        }
        if (string.IsNullOrEmpty(clean))
        {
            clean = "장비 " + SlotOrDefaultForRename(slot);
        }

        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }

            room.ConsolesText = ReplaceConsoleTitle(room.ConsolesText, slot, clean);
        }

        BroadcastAll(roomId, WireMsg.Rename(clean, slot));
    }

    private static string SlotOrDefaultForRename(string slot)
    {
        return string.IsNullOrEmpty(slot) ? "1" : slot;
    }

    private static string ReplaceConsoleTitle(string consolesText, string slot, string title)
    {
        var id = string.IsNullOrEmpty(slot) ? "1" : slot;
        if (string.IsNullOrEmpty(consolesText))
        {
            return id + "\t" + title + "\t0";
        }

        var lines = consolesText.Split('\n');
        var found = false;
        var sb = new StringBuilder();
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (string.IsNullOrEmpty(line))
            {
                continue;
            }

            var tab = line.IndexOf('\t');
            var lineId = tab < 0 ? line : line.Substring(0, tab);
            if (lineId == id)
            {
                var open = "0";
                if (tab >= 0)
                {
                    var rest = line.Substring(tab + 1);
                    var tab2 = rest.LastIndexOf('\t');
                    if (tab2 >= 0)
                    {
                        open = rest.Substring(tab2 + 1);
                    }
                }
                line = id + "\t" + title + "\t" + open;
                found = true;
            }

            if (sb.Length > 0)
            {
                sb.Append('\n');
            }
            sb.Append(line);
        }

        if (!found)
        {
            if (sb.Length > 0)
            {
                sb.Append('\n');
            }
            sb.Append(id + "\t" + title + "\t0");
        }

        return sb.ToString();
    }

    private static HashSet<string> SlotsInConsoles(string text)
    {
        var slots = new HashSet<string>();
        if (string.IsNullOrEmpty(text))
        {
            return slots;
        }

        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (string.IsNullOrEmpty(line))
            {
                continue;
            }

            var tab = line.IndexOf('\t');
            var id = tab < 0 ? line.Trim() : line.Substring(0, tab);
            if (!string.IsNullOrEmpty(id))
            {
                slots.Add(id);
            }
        }

        return slots;
    }

    private static void PruneHistoryBySlots(Room room, HashSet<string> slots)
    {
        if (room == null || slots == null || slots.Count == 0)
        {
            return;
        }

        var keptLog = new List<string>();
        var bytes = 0;
        for (var i = 0; i < room.History.Count; i++)
        {
            var item = room.History[i];
            if (!slots.Contains(WireMsg.SlotFromJson(item)))
            {
                continue;
            }
            keptLog.Add(item);
            bytes += item.Length;
        }
        room.History.Clear();
        room.History.AddRange(keptLog);
        room.HistoryBytes = bytes;

        var keptCmd = new List<string>();
        for (var i = 0; i < room.CmdHistory.Count; i++)
        {
            var item = room.CmdHistory[i];
            if (slots.Contains(WireMsg.SlotFromJson(item)))
            {
                keptCmd.Add(item);
            }
        }
        room.CmdHistory.Clear();
        room.CmdHistory.AddRange(keptCmd);
    }

    private static string SlotOf(WireMsg msg)
    {
        if (msg == null || string.IsNullOrEmpty(msg.slot))
        {
            return "1";
        }
        return msg.slot;
    }

    private static void PublishCommandLog(string roomId, string from, string text, string slot)
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        var payload = WireMsg.CmdLog(text, from, slot);
        RememberCmd(roomId, payload.ToJson());
        BroadcastAll(roomId, payload);
    }

    private static void RememberCmd(string roomId, string json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return;
        }

        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }

            room.CmdHistory.Add(json);
            while (room.CmdHistory.Count > 100)
            {
                room.CmdHistory.RemoveAt(0);
            }
        }
    }

    private static void RemoveClient(Client client)
    {
        if (client == null)
        {
            return;
        }

        if (client.HttpMode)
        {
            client.HttpClosed = true;
            try
            {
                client.HttpPulse.Set();
            }
            catch
            {
            }
        }

        var hostLeft = false;

        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(client.RoomId, out room))
            {
                return;
            }

            if (room.Host == client)
            {
                room.Host = null;
                hostLeft = true;
            }
            else
            {
                room.Guests.Remove(client);
            }

            if (room.Host == null && room.Guests.Count == 0)
            {
                Rooms.Remove(client.RoomId);
            }
        }

        if (hostLeft)
        {
            BroadcastToGuests(client.RoomId, WireMsg.Closed("시험팀이 공유를 종료했습니다."));
            CloseGuests(client.RoomId);
            lock (Gate)
            {
                Rooms.Remove(client.RoomId);
            }
        }
        else
        {
            BroadcastPeers(client.RoomId);
        }
    }

    private static void CloseGuests(string roomId)
    {
        List<Client> guests;
        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }
            guests = new List<Client>(room.Guests);
        }

        foreach (var guest in guests)
        {
            if (guest.HttpMode)
            {
                guest.HttpClosed = true;
                try
                {
                    guest.HttpPulse.Set();
                }
                catch
                {
                }
                continue;
            }

            try
            {
                if (guest.Socket != null)
                {
                    guest.Socket.Close();
                }
            }
            catch
            {
            }
        }
    }

    private static void BroadcastPeers(string roomId)
    {
        string hostName = null;
        var guestNames = new List<string>();
        var targets = new List<Client>();

        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }

            if (room.Host != null)
            {
                hostName = room.Host.Name;
                targets.Add(room.Host);
            }

            foreach (var guest in room.Guests)
            {
                guestNames.Add(guest.Name);
                targets.Add(guest);
            }
        }

        var payload = WireMsg.Peers(hostName ?? "", guestNames.ToArray());
        for (var i = 0; i < targets.Count; i++)
        {
            Deliver(targets[i], payload);
        }
    }

    private static void BroadcastToGuests(string roomId, WireMsg payload)
    {
        List<Client> guests;
        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }
            guests = new List<Client>(room.Guests);
        }

        for (var i = 0; i < guests.Count; i++)
        {
            Deliver(guests[i], payload);
        }
    }

    private static void BroadcastAll(string roomId, WireMsg payload)
    {
        List<Client> targets;
        lock (Gate)
        {
            Room room;
            if (!Rooms.TryGetValue(roomId, out room))
            {
                return;
            }
            targets = new List<Client>();
            if (room.Host != null)
            {
                targets.Add(room.Host);
            }
            foreach (var guest in room.Guests)
            {
                targets.Add(guest);
            }
        }

        for (var i = 0; i < targets.Count; i++)
        {
            Deliver(targets[i], payload);
        }
    }

    private static void SendToHost(string roomId, WireMsg payload)
    {
        Client host = null;
        lock (Gate)
        {
            Room room;
            if (Rooms.TryGetValue(roomId, out room))
            {
                host = room.Host;
            }
        }

        Deliver(host, payload);
    }

    private static void Deliver(Client client, WireMsg payload)
    {
        if (client == null || payload == null)
        {
            return;
        }

        if (client.HttpMode)
        {
            EnqueueHttp(client, payload.ToJson());
            return;
        }

        SendJson(client.Socket, payload);
    }

    private static void SendJson(WsConn socket, WireMsg payload)
    {
        if (socket == null || !socket.IsOpen)
        {
            return;
        }

        try
        {
            socket.SendText(payload.ToJson());
        }
        catch
        {
        }
    }

    private static void SendError(WsConn socket, string message)
    {
        SendJson(socket, WireMsg.Error(message));
    }

    private static string Nz(string value)
    {
        return value ?? "";
    }

    private class Client
    {
        public WsConn Socket;
        public string Role;
        public string Name;
        public string RoomId;
        public bool HttpMode;
        public string Sid;
        public DateTime LastSeen;
        public bool HttpClosed;
        public readonly Queue<string> HttpQueue = new Queue<string>();
        public readonly object HttpLock = new object();
        public readonly AutoResetEvent HttpPulse = new AutoResetEvent(false);
    }

    private class Room
    {
        public Client Host;
        public readonly List<Client> Guests = new List<Client>();
        public readonly List<string> History = new List<string>();
        public readonly List<string> CmdHistory = new List<string>();
        public string ConsolesText;
        public int HistoryBytes;
    }
}

[DataContract]
public class WireMsg
{
    [DataMember(EmitDefaultValue = false)]
    public string type;

    [DataMember(EmitDefaultValue = false)]
    public string role;

    [DataMember(EmitDefaultValue = false)]
    public string room;

    [DataMember(EmitDefaultValue = false)]
    public string name;

    [DataMember(EmitDefaultValue = false)]
    public string text;

    [DataMember(EmitDefaultValue = false)]
    public string from;

    [DataMember(EmitDefaultValue = false)]
    public string sid;

    [DataMember(EmitDefaultValue = false)]
    public string slot;

    [DataMember(EmitDefaultValue = false)]
    public string message;

    [DataMember(EmitDefaultValue = false)]
    public string host;

    [DataMember(EmitDefaultValue = false)]
    public string[] guests;

    [DataMember(EmitDefaultValue = false)]
    public int guestCount;

    public static WireMsg Parse(string json)
    {
        try
        {
            var serializer = new DataContractJsonSerializer(typeof(WireMsg));
            var bytes = Encoding.UTF8.GetBytes(json);
            using (var stream = new MemoryStream(bytes))
            {
                var parsed = serializer.ReadObject(stream) as WireMsg;
                if (parsed != null && !string.IsNullOrEmpty(parsed.type))
                {
                    return parsed;
                }
            }
        }
        catch
        {
        }

        return ParseLoose(json);
    }

    public string ToJson()
    {
        var sb = new StringBuilder();
        sb.Append('{');
        AppendField(sb, "type", type);
        AppendField(sb, "role", role);
        AppendField(sb, "room", room);
        AppendField(sb, "name", name);
        AppendField(sb, "text", text);
        AppendField(sb, "from", from);
        AppendField(sb, "sid", sid);
        AppendField(sb, "slot", slot);
        AppendField(sb, "message", message);
        AppendField(sb, "host", host);
        if (guests != null)
        {
            if (sb[sb.Length - 1] != '{')
            {
                sb.Append(',');
            }
            sb.Append("\"guests\":[");
            for (var i = 0; i < guests.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(',');
                }
                sb.Append('"').Append(Esc(guests[i])).Append('"');
            }
            sb.Append("],\"guestCount\":").Append(guests.Length);
        }
        sb.Append('}');
        return sb.ToString();
    }

    private static void AppendField(StringBuilder sb, string key, string value)
    {
        if (value == null)
        {
            return;
        }
        if (sb[sb.Length - 1] != '{')
        {
            sb.Append(',');
        }
        sb.Append('"').Append(key).Append("\":\"").Append(Esc(value)).Append('"');
    }

    private static string Esc(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "";
        }

        var sb = new StringBuilder();
        foreach (var ch in value)
        {
            if (ch == '"')
            {
                sb.Append("\\\"");
            }
            else if (ch == '\\')
            {
                sb.Append("\\\\");
            }
            else if (ch == '\n')
            {
                sb.Append("\\n");
            }
            else if (ch == '\r')
            {
                sb.Append("\\r");
            }
            else if (ch == '\t')
            {
                sb.Append("\\t");
            }
            else if (ch < 32)
            {
                sb.Append("\\u");
                sb.Append(((int)ch).ToString("x4"));
            }
            else
            {
                sb.Append(ch);
            }
        }
        return sb.ToString();
    }

    private static WireMsg ParseLoose(string json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return null;
        }

        return new WireMsg
        {
            type = GetJsonString(json, "type"),
            role = GetJsonString(json, "role"),
            room = GetJsonString(json, "room"),
            name = GetJsonString(json, "name"),
            text = GetJsonString(json, "text"),
            from = GetJsonString(json, "from"),
            sid = GetJsonString(json, "sid"),
            slot = GetJsonString(json, "slot"),
            message = GetJsonString(json, "message"),
        };
    }

    public static string SlotFromJson(string json)
    {
        if (string.IsNullOrEmpty(json) || json[0] != '{')
        {
            return "1";
        }

        var slot = GetJsonString(json, "slot");
        return string.IsNullOrEmpty(slot) ? "1" : slot;
    }

    private static string GetJsonString(string json, string key)
    {
        var needle = "\"" + key + "\"";
        var at = json.IndexOf(needle, StringComparison.Ordinal);
        if (at < 0)
        {
            return "";
        }

        var colon = json.IndexOf(':', at + needle.Length);
        if (colon < 0)
        {
            return "";
        }

        var i = colon + 1;
        while (i < json.Length && (json[i] == ' ' || json[i] == '\t'))
        {
            i++;
        }
        if (i >= json.Length || json[i] != '"')
        {
            return "";
        }

        i++;
        var sb = new StringBuilder();
        while (i < json.Length)
        {
            var ch = json[i];
            if (ch == '"')
            {
                break;
            }
            if (ch == '\\' && i + 1 < json.Length)
            {
                var next = json[i + 1];
                if (next == 'n')
                {
                    sb.Append('\n');
                }
                else if (next == 'r')
                {
                    sb.Append('\r');
                }
                else if (next == 't')
                {
                    sb.Append('\t');
                }
                else
                {
                    sb.Append(next);
                }
                i += 2;
                continue;
            }
            sb.Append(ch);
            i++;
        }
        return sb.ToString();
    }

    public static WireMsg Log(string text)
    {
        return Log(text, "1");
    }

    public static WireMsg Log(string text, string slot)
    {
        return new WireMsg { type = "log", text = text, slot = SlotOrDefault(slot) };
    }

    public static WireMsg History(string text)
    {
        return new WireMsg { type = "history", text = text };
    }

    public static WireMsg Cmd(string text, string from)
    {
        return Cmd(text, from, "1");
    }

    public static WireMsg Cmd(string text, string from, string slot)
    {
        return new WireMsg { type = "cmd", text = text, from = from, slot = SlotOrDefault(slot) };
    }

    public static WireMsg Keys(string text, string from)
    {
        return Keys(text, from, "1");
    }

    public static WireMsg Keys(string text, string from, string slot)
    {
        return new WireMsg { type = "keys", text = text, from = from, slot = SlotOrDefault(slot) };
    }

    public static WireMsg Chat(string text, string from)
    {
        return new WireMsg { type = "chat", text = text, from = from };
    }

    public static WireMsg CmdLog(string text, string from)
    {
        return CmdLog(text, from, "1");
    }

    public static WireMsg CmdLog(string text, string from, string slot)
    {
        return new WireMsg { type = "cmdlog", text = text, from = from, slot = SlotOrDefault(slot) };
    }

    public static WireMsg Consoles(string text)
    {
        return new WireMsg { type = "consoles", text = text };
    }

    public static WireMsg Rename(string text, string slot)
    {
        return new WireMsg { type = "rename", text = text, slot = SlotOrDefault(slot) };
    }

    private static string SlotOrDefault(string slot)
    {
        return string.IsNullOrEmpty(slot) ? "1" : slot;
    }

    public static WireMsg Closed(string message)
    {
        return new WireMsg { type = "closed", message = message };
    }

    public static WireMsg Error(string message)
    {
        return new WireMsg { type = "error", message = message };
    }

    public static WireMsg Peers(string hostName, string[] guestNames)
    {
        return new WireMsg
        {
            type = "peers",
            host = hostName,
            guests = guestNames,
            guestCount = guestNames.Length,
        };
    }
}
