const axios = require('axios');
const cheerio = require('cheerio');
const stations = require('../stations.json'); // Увери се, че пътят до файла е правилен!

// --- Твоите помощни функции (остават непроменени, защото са перфектни) ---
function splitWords(inputString) {
    let textWithoutSpaces = inputString.replace(/\s\s+/g, ' ');
    textWithoutSpaces = textWithoutSpaces.split(/\s+/);
    return textWithoutSpaces.filter(word => word !== '');
}

function getDelayInfo(info) {
    let delayMinutes = 0;
    let delayString = "";
    let delayInfo = "";

    if ((info[0].includes("допълнителна") || info[0].includes("more")) && (info[1].includes("информация") || info[1].includes("information"))) {
        delayString = info[0] + " " + info[1];
        delayInfo = info.slice(3).join(" ");
    } else if (info[0].includes("Bus") || info[0].includes("Трансбордиране")) {
        if (info[0].includes("Bus")) {
            delayString = "Transfer by bus."
        } else {
            delayString = info[0] + " " + info[1] + " " + info[2] + ".";
        }
        delayInfo = info.slice(3).join(" ");
    } else {
        for (let index = 0; index < 3; index++) {
            delayString += info[index];
            delayString += " ";
            if (index === 1) delayMinutes = parseInt(info[index]);
        }
        delayInfo = info.slice(3).join(" ");
    }
    return { delayMinutes, delayString, delayInfo };
}

function makeTrainJson(string, trainNum, delayInfo) {
    let result = {};
    let prefix = (delayInfo.length !== 0);
    let station = "";

    for (let index = 1 + prefix; index < string.length; index++) {
        station += string[index];
        station += " ";
    }

    if (delayInfo.length === 0) {
        delayInfo = { delayMinutes: 0, delayString: "", delayInfo: "" };
    }

    result = {
        direction: station,
        time: 0,
        isDelayed: prefix,
        delayedTime: 0,
        delayInfo: delayInfo,
        type: trainNum[0],
        trainNum: trainNum[1]
    };

    if (prefix) {
        result["time"] = string[1];
        result["delayedTime"] = string[0];
    } else {
        result["time"] = string[0];
    }

    let delayStr = result["delayInfo"]["delayString"];
    if (result["isDelayed"] && (delayStr.includes("Трансбордиране") || delayStr.includes("bus") || delayStr.includes("more information") || delayStr.includes("допълнителна информация"))) {
        result["direction"] = result["time"] + " " + result["direction"];
        result["time"] = result["delayedTime"];
        result["delayedTime"] = 0;
    }

    return result;
}

function translateNumberToStation(number) {
    const foundStation = stations.find((s) => s.id === number);
    return foundStation ? foundStation.romanizedName : null;
}

function getEverythingPastLoadingStation(station) {
    let loadingStation = false;
    let result = "";
    for (let index = 0; index < station.length; index++) {
        if (station[index] === "loading...") loadingStation = true;
        else if (loadingStation) {
            result += station[index];
            result += " ";
        }
    }
    return result;
}

// --- Същинският контролер с новия Bypass метод ---

const getLiveBoard = async (req, res) => {
    try {
        const stationNumber = parseInt(req.params.stationNumber);
        const language = req.params.language;
        const type = req.params.type;

        // Валидации
        if (isNaN(stationNumber)) return res.status(400).json({ error: 'Bad Request! Station number is not correct!' });
        if ([1001, 1002, 1003].includes(stationNumber)) return res.status(400).json({ error: 'There is no live board for these stations!' });
        if (language !== "bg" && language !== "en") return res.status(400).json({ error: 'Bad Request! Language does not exist!' });
        if (type !== "departures" && type !== "arrivals") return res.status(400).json({ error: 'Bad Request! Wrong type of live table!' });

        const stationName = translateNumberToStation(stationNumber);
        if (!stationName) return res.status(404).json({ error: 'Station does not exist!' });

        const url = `https://live.bdz.bg/${language}/${stationName.toLowerCase()}/${type}`;

        // 1. ПОДГОТОВКА: Имитираме браузър
        const fakeHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        };

        // 2. СТЪПКА 1 (Handshake): Взимаме бисквитката от главната страница
        const initialResponse = await axios.get('https://live.bdz.bg/', { headers: fakeHeaders });
        const cookies = initialResponse.headers['set-cookie'];

        if (cookies) {
            fakeHeaders['Cookie'] = cookies.map(c => c.split(';')[0]).join('; ');
        }

        // 3. СТЪПКА 2 (Fetch): Теглим същинските данни с вече "валидната" сесия
        const response = await axios.get(url, { headers: fakeHeaders });



        // 4. ПАРСВАНЕ: Твоята логика с Cheerio
        const content = cheerio.load(response.data);
        let station = "";
        content('#content').each((index, element) => {
            station = content(element).find('.mb-0').text();
            station = splitWords(station);
            station = getEverythingPastLoadingStation(station);
        });

        let trainsInfo = [];
        content('.timetableItem').each((index, element) => {
            let timeNames = splitWords(content(element).find('.mb-lg-0').text());
            let trainNum = splitWords(content(element).find('.text-nowrap').text());
            let delayInfo = splitWords(content(element).find('.col-lg-3').text());

            if (delayInfo.length !== 0) delayInfo = getDelayInfo(delayInfo);

            let currInfo = makeTrainJson(timeNames, trainNum, delayInfo);
            trainsInfo.push(currInfo);
        });

        res.json({
            station: station,
            trains: trainsInfo,
        });

    } catch (error) {
        console.error('Scraping Error:', error.message);
        res.status(500).json({ error: 'Internal Server Error while fetching live data!' });
    }
};

module.exports = {
    getLiveBoard
};

