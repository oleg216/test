export var SessionState;
(function (SessionState) {
    SessionState["CREATED"] = "CREATED";
    SessionState["INITIALIZING"] = "INITIALIZING";
    SessionState["RTB_REQUESTING"] = "RTB_REQUESTING";
    SessionState["VAST_RESOLVING"] = "VAST_RESOLVING";
    SessionState["AD_LOADING"] = "AD_LOADING";
    SessionState["AD_PLAYING"] = "AD_PLAYING";
    SessionState["CONTENT_PLAYING"] = "CONTENT_PLAYING";
    SessionState["STOPPING"] = "STOPPING";
    SessionState["STOPPED"] = "STOPPED";
    SessionState["ERROR_VAST"] = "ERROR_VAST";
    SessionState["ERROR_MEDIA"] = "ERROR_MEDIA";
    SessionState["ERROR_NETWORK"] = "ERROR_NETWORK";
    SessionState["ERROR_TIMEOUT"] = "ERROR_TIMEOUT";
})(SessionState || (SessionState = {}));
export const ERROR_STATES = [
    SessionState.ERROR_VAST,
    SessionState.ERROR_MEDIA,
    SessionState.ERROR_NETWORK,
    SessionState.ERROR_TIMEOUT,
];
//# sourceMappingURL=types.js.map