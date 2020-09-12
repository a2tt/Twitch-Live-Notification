/**
 * Call twitch api
 *
 * @param url
 * @param qs
 * @param twitchToken
 * @param method
 * @returns {Promise<Response | void>}
 */
function request(url, qs = '', twitchToken = '', method = 'GET') {
    url = qs ? `${url}?${qs}` : url
    return fetch(url, {
        method,
        headers: {
            "Client-ID": TWITCH_CLIENT_ID,
            "Authorization": `Bearer ${twitchToken}`,
        },
    }).then(res => {
        if (res.status === 401) {
            storageClearCredential();
            chrome.browserAction.setBadgeBackgroundColor({color: [255, 0, 0, 255]});
            chrome.browserAction.setBadgeText({"text": '!'});
        }
        return res.json();
    }).catch(e => {
        console.error(e)
    });
}

/**
 * Get multiple user's info by user id(integer).
 * convert 'id'(int) to 'login id'(str)
 *
 * @param userIds
 * @param by
 * @returns {Promise<Array>}
 */
function getUserInfos(userIds = null, by = 'login') {
    let qss = [];
    if (userIds) {
        for (let i=0; i< Math.ceil(userIds.length / 100); i++) {
            let qs = new URLSearchParams()
            userIds.slice(100 * i, 100 * (i+1)).forEach(id => qs.append(by, id.trim()))
            qss.push(qs)
        }
    } else {
        qss.push(null)
    }

    return storageGetPromise([KEY_TWITCH_TOKEN]).then(storage => {
        let url = 'https://api.twitch.tv/helix/users';

        let requests = []
        qss.forEach(qs => requests.push(request(url, qs, storage[KEY_TWITCH_TOKEN])))
        return Promise.all(requests).then(values => {
            let res = {'data': []}
            values.forEach(r => res.data = res.data.concat(r.data));
            return res.data
        });
    });
}

/**
 * Get my info
 * @returns {Promise<Array>}
 */
function getMyInfo() {
    return getUserInfos(null)
}

/**
 * Get following user ids
 *
 * @param followerId
 * @param twitchToken
 * @param cursor
 * @param data: concatenated response
 * @returns {Promise<Array>}
 */
function getFollower(followerId, twitchToken, cursor=null, data=[]) {
    /*
    {
     data: [{from_id: <String>, from_name: <String>, to_id: <String>, to_name: <String>, followed_at: <String>}, <String>],
     pagination: {cursor: <String>},
     total: <Number>
    }
     */
    let url = 'https://api.twitch.tv/helix/users/follows'
    let qs = new URLSearchParams({
        from_id: followerId,
        first: '100',
    })
    cursor && qs.set('after', cursor) // pagination cursor

    return request(url, qs, twitchToken).then(res => {
        data = data.concat(res.data)
        if (String(res.data.length) === qs.get('first') && res.pagination.hasOwnProperty('cursor')) {
            return getFollower(followerId, twitchToken, res.pagination.cursor, data)
        } else {
            return data;
        }
    });
}

/**
 * Get streams that are active now
 *
 * @param userIds
 * @param twitchToken
 * @param cursor
 * @param data: concatenated response
 * @returns {Promise<Array>}
 */
function getActiveStream(userIds, twitchToken, cursor=null, data=[]) {
    let url = 'https://api.twitch.tv/helix/streams'
    let qss = [];
    for (let i=0; i< Math.ceil(userIds.length / 100); i++) {
        let qs = new URLSearchParams()
        userIds.slice(100 * i, 100 * (i+1)).forEach(id => qs.append('user_id', id.trim()));
        qss.push(qs);
    }

    let requests = []
    qss.forEach(qs => requests.push(request(url, qs, twitchToken)))
    return Promise.all(requests).then(values => {
       let res = {'data': []};
       values.forEach(r => res.data = res.data.concat(r.data));
       return res.data;
    });
}

/**
 * game id to game name
 * @param gameIds
 * @param twitchToken
 * @returns {Promise<Object>}
 */
function getGameName(gameIds, twitchToken) {
    let url = 'https://api.twitch.tv/helix/games'
    let qs = new URLSearchParams();
    gameIds.forEach(gameId => qs.append('id', gameId));
    return request(url, qs, twitchToken).then(res => res.data);
}

/**
 * Periodically check streams
 */
function updateLiveStream() {
    storageGetPromise([KEY_FOLLOWER_ID, KEY_TWITCH_TOKEN]).then(storage => {
        if (storage[KEY_FOLLOWER_ID]) {
            // get following list
            getFollower(storage[KEY_FOLLOWER_ID], storage[KEY_TWITCH_TOKEN]
            ).then(followingUsers => {
                // if following no one, return
                if (!followingUsers.length)
                    return _setLiveStream([]);
                let userIds = [];
                followingUsers.forEach(info => userIds.push(info.to_id));

                // convert followee id to login_id
                getUserInfos(userIds, 'id').then(userInfos => {
                    let userNameMap = {};
                    userInfos.forEach(data => userNameMap[data.id] = data.login);

                    // get active stream in following list
                    getActiveStream(userIds, storage[KEY_TWITCH_TOKEN]
                    ).then(streamInfos => {
                        // if no one is streaming, return
                        if (!streamInfos.length) return _setLiveStream([]);

                        let gameIds = [];
                        streamInfos.filter(info => info.type === 'live').forEach(data => gameIds.push(data.game_id));

                        // convert `game_id` to `game_name`
                        getGameName(gameIds, storage[KEY_TWITCH_TOKEN]
                        ).then(gameInfo => {
                            let gameNameMap = {};
                            gameInfo.forEach(data => gameNameMap[data.id] = data.name);
                            // insert game_name to stream data
                            let liveStreams = [];
                            streamInfos.forEach(data => {
                                data.game_name = gameNameMap.hasOwnProperty(data.game_id) ? gameNameMap[data.game_id] : ''
                                liveStreams.push({
                                    user_name: data.user_name,
                                    user_login: userNameMap[data.user_id],
                                    user_id: data.user_id,
                                    game_name: data.game_name,
                                    title: data.title,
                                    type: data.type,
                                    viewer_count: data.viewer_count,
                                });
                            });
                            _setLiveStream(liveStreams);
                        })
                    })
                })
            })
        }
    })
}

/**
 *
 * @param liveStreams
 * @private
 */
function _setLiveStream(liveStreams) {
    // save on storage
    storageSetPromise({
        [KEY_LIVE_STREAM]: liveStreams,
        [KEY_UPDATE_TS]: new Date().toISOString(),
    }).then(res => {
        chrome.browserAction.setBadgeBackgroundColor({color: [119, 44, 232, 255]});
        chrome.browserAction.setBadgeText({"text": String(liveStreams.length)});
        chrome.runtime.sendMessage({'name': EVENT_REFRESHED});
    })
}

/**
 * onAlarm + onMessage handler
 * @param data
 */
function eventHandler(data) {
    if (data.name === EVENT_UPDATE_LIVE_STREAM) {
        updateLiveStream()
    }
}

window.onload = function () {
    chrome.alarms.create(EVENT_UPDATE_LIVE_STREAM, {
        when: 1000, // Initial execution after 1 second
        periodInMinutes: 3, // every n minutes
    })

    chrome.alarms.onAlarm.addListener(eventHandler);
    chrome.runtime.onMessage.addListener(eventHandler);
}
