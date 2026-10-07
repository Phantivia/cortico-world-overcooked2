using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace CorticoOvercooked2
{
    /// <summary>
    /// Minimal JSON for the bridge: the game ships no JSON library usable on .NET 3.5. Objects
    /// parse to Dictionary&lt;string, object&gt;, arrays to List&lt;object&gt;, numbers to double.
    /// </summary>
    internal static class Json
    {
        public static object Parse(string text)
        {
            int i = 0;
            var value = Value(text, ref i);
            Skip(text, ref i);
            if (i != text.Length) throw new FormatException("trailing characters at " + i);
            return value;
        }

        public static string Quote(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static string Num(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
            return Math.Round(v, 3).ToString("R", CultureInfo.InvariantCulture);
        }

        private static void Skip(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        private static object Value(string s, ref int i)
        {
            Skip(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end");
            char c = s[i];
            if (c == '{')
            {
                var obj = new Dictionary<string, object>();
                i++;
                Skip(s, ref i);
                if (s[i] == '}') { i++; return obj; }
                while (true)
                {
                    Skip(s, ref i);
                    string key = String(s, ref i);
                    Skip(s, ref i);
                    if (s[i++] != ':') throw new FormatException("expected ':' at " + i);
                    obj[key] = Value(s, ref i);
                    Skip(s, ref i);
                    char next = s[i++];
                    if (next == '}') return obj;
                    if (next != ',') throw new FormatException("expected ',' at " + i);
                }
            }
            if (c == '[')
            {
                var list = new List<object>();
                i++;
                Skip(s, ref i);
                if (s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(Value(s, ref i));
                    Skip(s, ref i);
                    char next = s[i++];
                    if (next == ']') return list;
                    if (next != ',') throw new FormatException("expected ',' at " + i);
                }
            }
            if (c == '"') return String(s, ref i);
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (s.Length - i >= 5 && string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i) throw new FormatException("unexpected '" + c + "' at " + i);
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        private static string String(string s, ref int i)
        {
            if (s[i] != '"') throw new FormatException("expected string at " + i);
            i++;
            var sb = new StringBuilder();
            while (true)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u': sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber)); i += 4; break;
                    default: sb.Append(e); break;
                }
            }
        }
    }

    /// <summary>Builds one JSON object in insertion order; null values are left out.</summary>
    internal sealed class JObj
    {
        private readonly StringBuilder _sb = new StringBuilder("{");
        private bool _first = true;

        private JObj Key(string key)
        {
            if (!_first) _sb.Append(',');
            _first = false;
            _sb.Append(Json.Quote(key)).Append(':');
            return this;
        }

        public JObj Str(string key, string value) { if (value != null) Key(key)._sb.Append(Json.Quote(value)); return this; }
        public JObj Num(string key, double value) { Key(key)._sb.Append(Json.Num(value)); return this; }
        public JObj Int(string key, long value) { Key(key)._sb.Append(value.ToString(CultureInfo.InvariantCulture)); return this; }
        public JObj Bool(string key, bool value) { Key(key)._sb.Append(value ? "true" : "false"); return this; }
        public JObj Raw(string key, string json) { if (json != null) Key(key)._sb.Append(json); return this; }
        public JObj Obj(string key, JObj value) { if (value != null) Key(key)._sb.Append(value.ToString()); return this; }

        public static string Array(IEnumerable<string> jsonItems)
        {
            var sb = new StringBuilder("[");
            bool first = true;
            foreach (var item in jsonItems)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(item);
            }
            return sb.Append(']').ToString();
        }

        public static string Strings(IEnumerable<string> items)
        {
            var quoted = new List<string>();
            foreach (var s in items) quoted.Add(Json.Quote(s));
            return Array(quoted);
        }

        public override string ToString() => _sb.ToString() + "}";
    }

    /// <summary>Typed reads from a parsed request object.</summary>
    internal static class Req
    {
        public static string Str(Dictionary<string, object> r, string key) => r.TryGetValue(key, out var v) ? v as string : null;
        public static bool Bool(Dictionary<string, object> r, string key) => r.TryGetValue(key, out var v) && v is bool b && b;

        public static double? Num(Dictionary<string, object> r, string key)
        {
            if (r.TryGetValue(key, out var v) && v is double d) return d;
            return null;
        }

        public static List<object> List(Dictionary<string, object> r, string key) => r.TryGetValue(key, out var v) ? v as List<object> : null;
    }
}
