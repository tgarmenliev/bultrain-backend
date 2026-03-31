const scheduleController = require('./scheduleController');

/**
 * GET /api/schedule/:language/:from/:to
 * Returns schedule for the current date in Bulgaria, filtering out past options.
 */
exports.getScheduleCurrentDate = (req, res) => {
    const { language, from, to } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Invalid language' });
    }

    try {
        // 1. Get current date and time in Bulgaria (Europe/Sofia)
        const now = new Date();
        const bgTimeString = now.toLocaleString("en-US", { timeZone: "Europe/Sofia" });
        const bgDate = new Date(bgTimeString);

        const yyyy = bgDate.getFullYear();
        const mm = String(bgDate.getMonth() + 1).padStart(2, '0');
        const dd = String(bgDate.getDate()).padStart(2, '0');
        const currentDateStr = `${yyyy}-${mm}-${dd}`;

        const bgHours = bgDate.getHours();
        const bgMinutes = bgDate.getMinutes();
        const bgCurrentMinsFromMidnight = bgHours * 60 + bgMinutes;

        // 2. Call the scheduleController logic for today
        const result = scheduleController.generateScheduleData(language, from, to, currentDateStr);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        // 3. (Removed time filtering so all trains for the day are returned)
        // const futureOptions = result.data.options.filter(opt => opt.departMins > bgCurrentMinsFromMidnight);

        // 4. Strip internal tracking fields (departMins, arriveMins)
        const finalOptions = result.data.options.map(({ departMins, arriveMins, ...rest }) => rest);

        const responseData = {
            ...result.data,
            totalTrains: finalOptions.length,
            options: finalOptions
        };

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(responseData, null, 4));

    } catch (error) {
        console.error('scheduleSecController error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
