const API_URL = 'https://api.openweathermap.org/data/2.5/weather';

export const definition = {
  type: 'function',
  name: 'get_weather',
  description: '指定された場所の天気を取得します',
  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: '都道府県名, e.g. 東京都,大阪,北海道'
      }
    },
    required: ['location']
  }
};

/**
 * OpenWeatherMap から天気を取得して読み上げやすい文章にする。
 * @param {{ location: string }} args
 * @param {{ config: object, log: import('fastify').FastifyBaseLogger }} context
 */
export const handler = async ({ location }, { config, log }) => {
  const apiKey = config.openWeatherApiKey;
  if (!apiKey) {
    return { error: 'OpenWeatherMap の API キー (OPEN_WEATHER_API_KEY) が設定されていません。' };
  }

  const url = new URL(API_URL);
  url.searchParams.set('q', `${location},JP`); // 国コードを付けて検索精度を上げる
  url.searchParams.set('appid', apiKey);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('lang', 'ja');

  const response = await fetch(url);

  if (response.status === 404) {
    return { error: `${location} の天気情報が見つかりませんでした。正しい都道府県名を指定してください。` };
  }
  if (!response.ok) {
    log.error({ status: response.status }, '天気情報の取得に失敗しました');
    return { error: `天気情報の取得に失敗しました (${response.status})。` };
  }

  const data = await response.json();
  const today = new Date();
  const date = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;

  return {
    summary:
      `${location}の${date}の天気は${data.weather[0].description}、` +
      `現在の気温は${data.main.temp}℃（最低${data.main.temp_min}℃〜最高${data.main.temp_max}℃）、` +
      `湿度${data.main.humidity}%、風速${data.wind.speed}m/sです。`
  };
};
