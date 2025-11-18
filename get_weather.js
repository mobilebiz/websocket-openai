/**
 * 指定された場所の天気情報をOpenWeatherMap APIから取得する関数
 * 
 * @param {string} location - 都道府県名 (例: '東京都', '大阪', '北海道')
 * @returns {Promise<string>} - 天気情報を含む文字列
 */
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const OPEN_WEATHER_API_KEY = process.env.OPEN_WEATHER_API_KEY;

export async function getWeatherInfo(location) {
  console.log('🐞 getWeatherInfo', location);
  try {
    if (!OPEN_WEATHER_API_KEY) {
      throw new Error('OpenWeatherMap APIキーが設定されていません。環境変数OPEN_WEATHER_API_KEYを確認してください。');
    }

    // 日本の国コードを追加して検索精度を上げる
    const searchQuery = `${location},JP`;

    // OpenWeatherMap APIへのリクエスト
    const apiUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(searchQuery)}&appid=${OPEN_WEATHER_API_KEY}&units=metric&lang=ja`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
      if (response.status === 404) {
        return `${location}の天気情報が見つかりませんでした。正しい都道府県名を指定してください。`;
      }
      throw new Error(`APIリクエストエラー: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // 天気情報を整形
    const weather = data.weather[0].description;
    const temperature = data.main.temp;
    const tempMin = data.main.temp_min;
    const tempMax = data.main.temp_max;
    const humidity = data.main.humidity;
    const windSpeed = data.wind.speed;

    // 現在の日時
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const formattedDate = `${year}/${month}/${day}`;

    // 天気情報メッセージの作成
    return `${location}の${formattedDate}の天気は${weather}、現在の気温は${temperature}℃（最低${tempMin}℃〜最高${tempMax}℃）、湿度${humidity}%、風速${windSpeed}m/sです。`;
  } catch (error) {
    console.error('天気情報の取得中にエラーが発生しました:', error);
    return `${location}の天気情報を取得できませんでした: ${error.message}`;
  }
} 