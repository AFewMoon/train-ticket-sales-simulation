/* 存储层：localStorage 封装，统一 key 前缀、JSON 容错 */
(function (global) {
  'use strict';

  var PREFIX = 'tts:';

  var storage = {
    KEYS: {
      stations: PREFIX + 'stations',
      lines: PREFIX + 'lines',
      passengers: PREFIX + 'passengers',
      trains: PREFIX + 'trains',
      orders: PREFIX + 'orders',
      seq: PREFIX + 'seq',
      seeded: PREFIX + 'seeded'
    },

    /** 读取并解析 JSON；解析失败或结构不符时回退为 fallback */
    read: function (key, fallback) {
      try {
        var raw = global.localStorage.getItem(key);
        if (raw === null) return fallback;
        var val = JSON.parse(raw);
        return val === null || val === undefined ? fallback : val;
      } catch (e) {
        return fallback;
      }
    },

    /** 序列化写入；失败（如隐私模式配额）返回 false */
    write: function (key, value) {
      try {
        global.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },

    remove: function (key) {
      try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
  };

  global.Storage = storage;
})(window);
