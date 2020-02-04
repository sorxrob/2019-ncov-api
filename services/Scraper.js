const axios = require('axios');
const cheerio = require('cheerio');
const dotenv = require('dotenv');
const NodeGeocoder = require('node-geocoder');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const geocoder = NodeGeocoder({
	provider: 'openstreetmap'
});
dotenv.config();
const mappedCoordinates = {};

// Novel Coronavirus (2019-nCoV) Cases, provided by JHU CSSE
const doc = new GoogleSpreadsheet('1wQVypefm946ch4XDp37uZ-wartW4V7ILdg-qYiDXUHM');
doc.useApiKey(process.env.GOOGLE_API_KEY);

class Scraper {
	async getHTML(url) {
		const res = await axios(url);
		return cheerio.load(res.data);
	}

	async getTimeline() {
		const $ = await this.getHTML(
			'https://bnonews.com/index.php/2020/01/timeline-coronavirus-epidemic/'
		);
		const timelineDiv = $('#mvp-content-main');

		const data = timelineDiv
			.find('h4')
			.toArray()
			.map((h4, h4Idx) => ({
				date: $(h4)
					.text()
					.trim(),
				time: timelineDiv
					.find('ul')
					.eq(h4Idx)
					.children('li')
					.toArray()
					.map(li => ({
						time_and_description: $(li)
							.text()
							.trim()
							.replace(' (Source)', ''),
						source: $(li)
							.find('a')
							.attr('href')
					}))
			}));
		const latest = await this.getTimelineLatest();
		return [...latest, ...data].map(item => {
			return {
				...item,
				time: item.time
					.filter(
						i => !i.time_and_description.includes('Total at the end of the day')
					)
					.map(i => ({
						time: i.time_and_description.slice(0, 5),
						description: i.time_and_description.replace(
							`${i.time_and_description.slice(0, 5)}: `,
							''
						),
						source: i.source
					}))
			};
		});
	}

	async getTimelineLatest() {
		const $ = await this.getHTML(
			'https://bnonews.com/index.php/2020/02/the-latest-coronavirus-cases/'
		);
		const data = [];
		$('h2:contains("Timeline (GMT)")')
			.nextUntil('h3')
			.each((idx, el) => {
				if (el.name === 'h4') {
					const obj = {
						date: $(el)
							.text()
							.trim(),
						time: $(el)
							.next()
							.children('li')
							.toArray()
							.map(li => ({
								time_and_description: $(li)
									.text()
									.trim()
									.replace(' (Source)', ''),
								source: $(li)
									.find('a')
									.attr('href')
							}))
					};

					data.push(obj);
				}
			});

		return data;
	}

	async getConfirmedCases() {
		const $ = await this.getHTML(
			'https://en.wikipedia.org/wiki/2019%E2%80%9320_Wuhan_coronavirus_outbreak'
		);
		const data = [];
		const sourceTable = $('.wikitable')
			.first()
			.find('tbody tr');
		sourceTable.each((idx, el) => {
			if (
				idx === 0 ||
				idx === sourceTable.length - 1 ||
				idx === sourceTable.length - 2
			)
				return;

			const td = $(el).children('td');
			const references = td
				.eq(3)
				.children('sup')
				.toArray()
				.map(supEl => {
					const link = $(supEl)
						.find('a')
						.attr('href');
					return $(`li${link} .reference-text .citation a`).attr('href');
				});

			const country = td
				.eq(0)
				.text()
				.includes('China')
				? 'China'
				: td
						.eq(0)
						.text()
						.trim();

			data.push({
				country,
				cases: +td
					.eq(1)
					.text()
					.trim()
					.replace(/,/g, ''),
				deaths: +td
					.eq(2)
					.text()
					.trim()
					.replace(/,/g, ''),
				references
			});
		});

		return Promise.all(
			data.map(item => {
				return this.geocode(item.country).then(({ lat, lon }) => {
					return {
						...item,
						coordinates: { lat, lon }
					};
				});
			})
		);
	}

	async getMainlandChinaDailyReport() {
		const $ = await this.getHTML(
			'https://en.wikipedia.org/wiki/2019%E2%80%9320_Wuhan_coronavirus_outbreak'
		);
		const data = [];
		$('.barbox table tbody tr').each((idx, el) => {
			if (idx === 0 || idx === 1) return;
			const td = $(el).children('td');
			data.push({
				date: td
					.eq(0)
					.text()
					.trim(),
				count: td
					.eq(2)
					.text()
					.replace(/\(.*?\)/, '')
					.trim()
			});
		});
		return data;
	}

	async getDailyDeaths() {
		const $ = await this.getHTML(
			'https://www.worldometers.info/coronavirus/coronavirus-death-toll/'
		);
		const data = [];

		const dailyDeathRef = $(
			'h3:contains("Daily Deaths of Novel Coronavirus (2019-nCoV)")'
		);

		dailyDeathRef
			.next()
			.find('thead tr')
			.each((idx, el) => {
				if (idx === 0) return;

				const td = $(el).children('td');
				data.push({
					date: td
						.eq(0)
						.text()
						.trim(),
					count: +td
						.eq(1)
						.text()
						.trim()
						.replace(/,/g, '')
				});
			});

		dailyDeathRef
			.next()
			.find('tbody tr')
			.each((_, el) => {
				const td = $(el).children('td');
				data.push({
					date: td
						.eq(0)
						.text()
						.trim(),
					count: +td
						.eq(1)
						.text()
						.trim()
						.replace(/,/g, '')
				});
			});
		return data.reverse();
	}

	async getCases() {
		try {
			await doc.loadInfo();

			// Get unique indexes
			const indexes = [];
			for (var x=0; x<doc.sheetsByIndex.length; x++) {
				const exists = indexes.filter(i => {
					return doc.sheetsByIndex[x].title.includes(doc.sheetsByIndex[i].title.split('_')[0]);
				});
				if (!exists.length) {
					indexes.push(x);
				}
				if (indexes.length === 6) break;
			}


			// Get rows per sheet
			const sheets = [];
			for(var x=0; x<indexes.length; x++) {
				const date = doc.sheetsByIndex[indexes[x]].title.split('_')[0];
				sheets.push(
					doc.sheetsByIndex[indexes[x]].getRows()
					.then((rows) => {
						return {
							date,
							data: rows.map(i => ({
								'Province/State': i['Province/State'],
								'Country/Region': i['Country/Region'],
								'Confirmed': i['Confirmed'],
								'Deaths': i['Deaths'],
								'Recovered': i['Recovered']
							}))
						}
					})
				);
			}
			const data = await Promise.all(sheets);
			return data.map((item) => ({
				...item,
				total_confirmed: item.data.reduce((a, b) => +a + +b.Confirmed, 0),
				total_deaths: item.data.reduce((a, b) => +a + +b.Deaths, 0),
				total_recovered: item.data.reduce((a, b) => +a + +b.Recovered, 0)
			}));
		} catch (e) {
			return null;
		}
	}

	async geocode(address) {
		if (mappedCoordinates[address]) {
			return mappedCoordinates[address];
		}

		const results = await geocoder.geocode(address);
		const coords = {
			lat: results[0].latitude,
			lon: results[0].longitude
		};
		// Set to mappedCoordinates so we don't have to query again
		mappedCoordinates[address] = coords;
		return coords;
	}
}

module.exports = Scraper;
