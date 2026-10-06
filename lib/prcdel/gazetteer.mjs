// Compact world gazetteer for headline geocoding: capitals plus cities PRC delegations and
// PRC-linked forums commonly visit. Country-only mentions resolve to the capital (flagged
// precision:'country'). Coordinates are city centres (WGS84, ~0.1° precision).

// [city, country, iso2, lat, lon, ...aliases]
const CITIES = [
  ['Cairo','Egypt','EG',30.04,31.24],['Alexandria','Egypt','EG',31.2,29.92],['Sharm el-Sheikh','Egypt','EG',27.92,34.33,'Sharm El Sheikh'],
  ['Beirut','Lebanon','LB',33.89,35.5],['Damascus','Syria','SY',33.51,36.29],['Amman','Jordan','JO',31.95,35.93],
  ['Baghdad','Iraq','IQ',33.31,44.37],['Erbil','Iraq','IQ',36.19,44.01],['Tehran','Iran','IR',35.69,51.39],
  ['Riyadh','Saudi Arabia','SA',24.71,46.68],['Jeddah','Saudi Arabia','SA',21.49,39.19],['Abu Dhabi','United Arab Emirates','AE',24.45,54.38],
  ['Dubai','United Arab Emirates','AE',25.2,55.27],['Doha','Qatar','QA',25.29,51.53],['Manama','Bahrain','BH',26.23,50.59],
  ['Kuwait City','Kuwait','KW',29.38,47.99],['Muscat','Oman','OM',23.59,58.41],['Sanaa','Yemen','YE',15.37,44.19],
  ['Ankara','Turkey','TR',39.93,32.86,'Türkiye'],['Istanbul','Turkey','TR',41.01,28.98],['Jerusalem','Israel','IL',31.77,35.21],
  ['Tel Aviv','Israel','IL',32.09,34.78],['Ramallah','Palestine','PS',31.9,35.2],
  ['Islamabad','Pakistan','PK',33.68,73.05],['Karachi','Pakistan','PK',24.86,67.01],['Lahore','Pakistan','PK',31.55,74.34],['Gwadar','Pakistan','PK',25.12,62.33],
  ['Kabul','Afghanistan','AF',34.56,69.21],['New Delhi','India','IN',28.61,77.21,'Delhi'],['Mumbai','India','IN',19.08,72.88],
  ['Dhaka','Bangladesh','BD',23.81,90.41],['Kathmandu','Nepal','NP',27.72,85.32],['Colombo','Sri Lanka','LK',6.93,79.85],
  ['Male','Maldives','MV',4.18,73.51],['Thimphu','Bhutan','BT',27.47,89.64],
  ['Tashkent','Uzbekistan','UZ',41.3,69.24],['Samarkand','Uzbekistan','UZ',39.65,66.96],['Nukus','Uzbekistan','UZ',42.46,59.6,'Karakalpakstan'],
  ['Astana','Kazakhstan','KZ',51.17,71.45],['Almaty','Kazakhstan','KZ',43.24,76.89],['Bishkek','Kyrgyzstan','KG',42.87,74.59],
  ['Dushanbe','Tajikistan','TJ',38.56,68.77],['Ashgabat','Turkmenistan','TM',37.96,58.33],['Baku','Azerbaijan','AZ',40.41,49.87],
  ['Tbilisi','Georgia','GE',41.72,44.79],['Yerevan','Armenia','AM',40.18,44.51],['Ulaanbaatar','Mongolia','MN',47.92,106.92],
  ['Moscow','Russia','RU',55.76,37.62],['St Petersburg','Russia','RU',59.93,30.36,'Saint Petersburg','St. Petersburg'],['Vladivostok','Russia','RU',43.12,131.89],
  ['Minsk','Belarus','BY',53.9,27.56],['Kyiv','Ukraine','UA',50.45,30.52,'Kiev'],
  ['Tokyo','Japan','JP',35.68,139.69],['Osaka','Japan','JP',34.69,135.5],['Seoul','South Korea','KR',37.57,126.98],['Pyongyang','North Korea','KP',39.04,125.76],
  ['Hanoi','Vietnam','VN',21.03,105.85],['Ho Chi Minh City','Vietnam','VN',10.82,106.63],['Vientiane','Laos','LA',17.98,102.63],
  ['Phnom Penh','Cambodia','KH',11.56,104.93],['Bangkok','Thailand','TH',13.76,100.5],['Naypyidaw','Myanmar','MM',19.76,96.08,'Nay Pyi Taw'],
  ['Yangon','Myanmar','MM',16.84,96.17],['Kuala Lumpur','Malaysia','MY',3.14,101.69],['Singapore','Singapore','SG',1.35,103.82],
  ['Jakarta','Indonesia','ID',-6.21,106.85],['Bali','Indonesia','ID',-8.34,115.09],['Manila','Philippines','PH',14.6,120.98],
  ['Dili','Timor-Leste','TL',-8.56,125.57],['Bandar Seri Begawan','Brunei','BN',4.9,114.94],
  ['Canberra','Australia','AU',-35.28,149.13],['Sydney','Australia','AU',-33.87,151.21],['Wellington','New Zealand','NZ',-41.29,174.78],
  ['Port Moresby','Papua New Guinea','PG',-9.44,147.18],['Honiara','Solomon Islands','SB',-9.43,159.95],['Suva','Fiji','FJ',-18.14,178.44],
  ['Apia','Samoa','WS',-13.83,-171.76],["Nuku'alofa",'Tonga','TO',-21.14,-175.2],['Port Vila','Vanuatu','VU',-17.73,168.32],['Tarawa','Kiribati','KI',1.45,173.0],
  ['Nairobi','Kenya','KE',-1.29,36.82],['Mombasa','Kenya','KE',-4.04,39.67],['Addis Ababa','Ethiopia','ET',9.03,38.74],['Djibouti','Djibouti','DJ',11.59,43.15],
  ['Kampala','Uganda','UG',0.35,32.58],['Kigali','Rwanda','RW',-1.95,30.06],['Dar es Salaam','Tanzania','TZ',-6.79,39.21],['Dodoma','Tanzania','TZ',-6.16,35.75],
  ['Khartoum','Sudan','SD',15.5,32.56],['Juba','South Sudan','SS',4.85,31.58],['Mogadishu','Somalia','SO',2.05,45.32],['Asmara','Eritrea','ER',15.32,38.93],
  ['Lusaka','Zambia','ZM',-15.39,28.32],['Harare','Zimbabwe','ZW',-17.83,31.05],['Lilongwe','Malawi','MW',-13.96,33.79],['Maputo','Mozambique','MZ',-25.97,32.57],
  ['Pretoria','South Africa','ZA',-25.75,28.19],['Johannesburg','South Africa','ZA',-26.2,28.05],['Cape Town','South Africa','ZA',-33.92,18.42],
  ['Windhoek','Namibia','NA',-22.56,17.08],['Gaborone','Botswana','BW',-24.65,25.91],['Luanda','Angola','AO',-8.84,13.23],['Antananarivo','Madagascar','MG',-18.88,47.51],
  ['Kinshasa','DR Congo','CD',-4.44,15.27,'Democratic Republic of the Congo','DRC'],['Brazzaville','Republic of the Congo','CG',-4.27,15.28],
  ['Libreville','Gabon','GA',0.42,9.47],['Yaounde','Cameroon','CM',3.85,11.5,'Yaoundé'],['Abuja','Nigeria','NG',9.06,7.5],['Lagos','Nigeria','NG',6.52,3.38],
  ['Accra','Ghana','GH',5.6,-0.19],['Abidjan','Ivory Coast','CI',5.36,-4.01,"Côte d'Ivoire","Cote d'Ivoire"],['Cotonou','Benin','BJ',6.37,2.39],
  ['Lome','Togo','TG',6.13,1.22,'Lomé'],['Dakar','Senegal','SN',14.72,-17.47],['Bamako','Mali','ML',12.64,-8.0],['Niamey','Niger','NE',13.51,2.13],
  ['Ouagadougou','Burkina Faso','BF',12.37,-1.52],['Conakry','Guinea','GN',9.64,-13.58],['Freetown','Sierra Leone','SL',8.47,-13.23],['Monrovia','Liberia','LR',6.29,-10.76],
  ["N'Djamena",'Chad','TD',12.13,15.06],['Bangui','Central African Republic','CF',4.39,18.56],['Nouakchott','Mauritania','MR',18.08,-15.98],
  ['Rabat','Morocco','MA',34.02,-6.84],['Casablanca','Morocco','MA',33.57,-7.59],['Algiers','Algeria','DZ',36.75,3.06],['Tunis','Tunisia','TN',36.81,10.18],
  ['Tripoli','Libya','LY',32.89,13.19],['Benghazi','Libya','LY',32.12,20.07],['Port Louis','Mauritius','MU',-20.16,57.5],['Victoria','Seychelles','SC',-4.62,55.45],
  ['London','United Kingdom','GB',51.51,-0.13,'UK','Britain'],['Paris','France','FR',48.86,2.35],['Berlin','Germany','DE',52.52,13.4],['Brussels','Belgium','BE',50.85,4.35],
  ['Madrid','Spain','ES',40.42,-3.7],['Lisbon','Portugal','PT',38.72,-9.14],['Rome','Italy','IT',41.9,12.5],['Vienna','Austria','AT',48.21,16.37],
  ['Budapest','Hungary','HU',47.5,19.04],['Belgrade','Serbia','RS',44.79,20.45],['Athens','Greece','GR',37.98,23.73],['Piraeus','Greece','GR',37.94,23.65],
  ['Warsaw','Poland','PL',52.23,21.01],['Prague','Czech Republic','CZ',50.08,14.44,'Czechia'],['Bratislava','Slovakia','SK',48.15,17.11],
  ['Bucharest','Romania','RO',44.43,26.1],['Sofia','Bulgaria','BG',42.7,23.32],['Zagreb','Croatia','HR',45.81,15.98],['Ljubljana','Slovenia','SI',46.06,14.51],
  ['Sarajevo','Bosnia and Herzegovina','BA',43.86,18.41],['Podgorica','Montenegro','ME',42.44,19.26],['Skopje','North Macedonia','MK',41.99,21.43],['Tirana','Albania','AL',41.33,19.82],
  ['Bern','Switzerland','CH',46.95,7.45],['Geneva','Switzerland','CH',46.2,6.14],['Davos','Switzerland','CH',46.8,9.84],['Amsterdam','Netherlands','NL',52.37,4.9],
  ['The Hague','Netherlands','NL',52.08,4.3],['Copenhagen','Denmark','DK',55.68,12.57],['Stockholm','Sweden','SE',59.33,18.07],['Oslo','Norway','NO',59.91,10.75],
  ['Helsinki','Finland','FI',60.17,24.94],['Dublin','Ireland','IE',53.35,-6.26],['Reykjavik','Iceland','IS',64.15,-21.94],['Tallinn','Estonia','EE',59.44,24.75],
  ['Riga','Latvia','LV',56.95,24.11],['Vilnius','Lithuania','LT',54.69,25.28],['Chisinau','Moldova','MD',47.01,28.86],['Valletta','Malta','MT',35.9,14.51],['Nicosia','Cyprus','CY',35.19,33.38],
  ['Washington','United States','US',38.9,-77.04,'Washington DC','Washington, D.C.','White House','US','U.S.'],['New York','United States','US',40.71,-74.01],['San Francisco','United States','US',37.77,-122.42],
  ['Ottawa','Canada','CA',45.42,-75.7],['Mexico City','Mexico','MX',19.43,-99.13,'Mexico'],['Havana','Cuba','CU',23.11,-82.37],['Panama City','Panama','PA',8.98,-79.52],
  ['San Jose','Costa Rica','CR',9.93,-84.08],['Managua','Nicaragua','NI',12.11,-86.24],['Tegucigalpa','Honduras','HN',14.07,-87.19],['San Salvador','El Salvador','SV',13.69,-89.22],
  ['Guatemala City','Guatemala','GT',14.63,-90.51],['Santo Domingo','Dominican Republic','DO',18.49,-69.93],['Kingston','Jamaica','JM',18.02,-76.8],
  ['Bridgetown','Barbados','BB',13.1,-59.61],['Port of Spain','Trinidad and Tobago','TT',10.65,-61.51],['Georgetown','Guyana','GY',6.8,-58.16],
  ['Caracas','Venezuela','VE',10.48,-66.9],['Bogota','Colombia','CO',4.71,-74.07,'Bogotá'],['Quito','Ecuador','EC',-0.18,-78.47],['Lima','Peru','PE',-12.05,-77.04],
  ['Chancay','Peru','PE',-11.57,-77.27],['La Paz','Bolivia','BO',-16.5,-68.15],['Santiago','Chile','CL',-33.45,-70.67],['Buenos Aires','Argentina','AR',-34.6,-58.38],
  ['Montevideo','Uruguay','UY',-34.9,-56.16],['Asuncion','Paraguay','PY',-25.26,-57.58,'Asunción'],['Brasilia','Brazil','BR',-15.79,-47.88,'Brasília'],
  ['Sao Paulo','Brazil','BR',-23.55,-46.63,'São Paulo'],['Rio de Janeiro','Brazil','BR',-22.91,-43.17],
];

// Country-only mention → capital index row.
const COUNTRY_CAPITAL = {};
const ROWS = CITIES.map(([city, country, iso2, lat, lon, ...aliases]) => ({ city, country, iso2, lat, lon, aliases }));
for (const r of ROWS) if (!COUNTRY_CAPITAL[r.country]) COUNTRY_CAPITAL[r.country] = r;
const COUNTRY_ALIASES = { 'Türkiye': 'Turkey', 'UAE': 'United Arab Emirates', 'Emirati': 'United Arab Emirates', 'Saudi': 'Saudi Arabia', 'Egyptian': 'Egypt', 'Lebanese': 'Lebanon',
  'Pakistani': 'Pakistan', 'Kenyan': 'Kenya', 'Nigerian': 'Nigeria', 'Ghanaian': 'Ghana', 'Ethiopian': 'Ethiopia', 'Libyan': 'Libya', 'Iranian': 'Iran', 'Iraqi': 'Iraq',
  'Indonesian': 'Indonesia', 'Malaysian': 'Malaysia', 'Cambodian': 'Cambodia', 'Vietnamese': 'Vietnam', 'Brazilian': 'Brazil', 'Argentine': 'Argentina', 'Peruvian': 'Peru',
  'Uzbek': 'Uzbekistan', 'Kazakh': 'Kazakhstan', 'Kyrgyz': 'Kyrgyzstan', 'Bangladeshi': 'Bangladesh', 'Sri Lankan': 'Sri Lanka', 'Nepali': 'Nepal', 'Serbian': 'Serbia',
  'Hungarian': 'Hungary', 'Russian': 'Russia', 'Japanese': 'Japan', 'Korean': 'South Korea', 'Mexican': 'Mexico', 'Cuban': 'Cuba', 'Djiboutian': 'Djibouti', 'Ugandan': 'Uganda',
  'Zambian': 'Zambia', 'Tanzanian': 'Tanzania', 'Moroccan': 'Morocco', 'Algerian': 'Algeria', 'Tunisian': 'Tunisia', 'Filipino': 'Philippines', 'Thai': 'Thailand',
  'Mongolian': 'Mongolia', 'Belarusian': 'Belarus', 'Azerbaijani': 'Azerbaijan', 'Georgian': 'Georgia', 'Afghan': 'Afghanistan', 'Qatari': 'Qatar', 'Omani': 'Oman',
  'Jordanian': 'Jordan', 'Syrian': 'Syria', 'Turkish': 'Turkey', 'Israeli': 'Israel', 'Palestinian': 'Palestine', 'Fijian': 'Fiji', 'Solomon': 'Solomon Islands',
  'South African': 'South Africa', 'Zimbabwean': 'Zimbabwe', 'Angolan': 'Angola', 'Senegalese': 'Senegal', 'Malian': 'Mali', 'Nicaraguan': 'Nicaragua', 'Venezuelan': 'Venezuela',
  'Colombian': 'Colombia', 'Chilean': 'Chile', 'Bolivian': 'Bolivia', 'Ecuadorian': 'Ecuador', 'Panamanian': 'Panama', 'Greek': 'Greece', 'Italian': 'Italy', 'French': 'France',
  'German': 'Germany', 'Spanish': 'Spain', 'British': 'United Kingdom', 'American': 'United States', 'Canadian': 'Canada', 'Australian': 'Australia', 'Indian': 'India' };

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TERMS = [];
const COUNTRYISH_ALIAS = /^(US|U\.S\.|UK|Britain|Mexico|Türkiye|DRC|Democratic Republic of the Congo|Côte d'Ivoire|Cote d'Ivoire|Czechia)$/;
for (const r of ROWS) for (const n of [r.city, ...r.aliases]) TERMS.push({ term: n, row: r, precision: COUNTRYISH_ALIAS.test(n) ? 'country' : 'city' });
for (const [country, row] of Object.entries(COUNTRY_CAPITAL)) TERMS.push({ term: country, row, precision: 'country' });
for (const [adj, country] of Object.entries(COUNTRY_ALIASES)) if (COUNTRY_CAPITAL[country]) TERMS.push({ term: adj, row: COUNTRY_CAPITAL[country], precision: 'country' });
TERMS.sort((a, b) => b.term.length - a.term.length);
const TERM_RE = TERMS.map(t => ({ ...t, re: new RegExp(`(^|[^\\p{L}])${esc(t.term)}(?=$|[^\\p{L}])`, 'u') }));

const PRC_RE = /\b(China|Chinese|Beijing|PRC|Shanghai|Xi'?an|Guangzhou|Shenzhen|Changsha|Hangzhou|Xiamen|Chongqing|Chengdu|Wuhan|Tianjin|Nanjing|Hong Kong)\b/i;

// All places a text mentions (non-PRC), most specific first, de-duplicated by city.
export function findPlaces(text) {
  const out = []; const seen = new Set(); let rest = ` ${text || ''} `;
  for (const t of TERM_RE) {
    const m = t.re.exec(rest);
    if (!m) continue;
    rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    const key = `${t.row.city}|${t.row.country}`;
    if (seen.has(key)) { const prev = out.find(o => `${o.city}|${o.country}` === key); if (prev && t.precision === 'city') prev.precision = 'city'; continue; }
    // a country-level hit is redundant when a city in that country already matched
    if (t.precision === 'country' && out.some(o => o.country === t.row.country)) continue;
    seen.add(key);
    out.push({ city: t.row.city, country: t.row.country, iso2: t.row.iso2, lat: t.row.lat, lon: t.row.lon, precision: t.precision, matched: t.term, index: m.index });
  }
  // a city hit supersedes an earlier country-level hit for the same country
  return out.filter(o => !(o.precision === 'country' && out.some(p => p !== o && p.country === o.country && p.precision === 'city')))
    .sort((a, b) => (a.precision === b.precision ? a.index - b.index : a.precision === 'city' ? -1 : 1));
}

export function placeByCity(city) {
  const r = ROWS.find(x => x.city.toLowerCase() === String(city || '').toLowerCase() || x.aliases.some(a => a.toLowerCase() === String(city || '').toLowerCase()));
  return r ? { city: r.city, country: r.country, iso2: r.iso2, lat: r.lat, lon: r.lon, precision: 'city' } : null;
}

export function mentionsPRC(text) { return PRC_RE.test(text || ''); }
export const GAZETTEER_SIZE = ROWS.length;
