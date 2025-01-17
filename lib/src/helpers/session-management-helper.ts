/**
 * Copyright (c) 2020, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
 *
 * WSO2 Inc. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { SESSION_STATE } from "@asgardeo/auth-js";
import {
    CHECK_SESSION_SIGNED_IN,
    CHECK_SESSION_SIGNED_OUT,
    INITIALIZED_SILENT_SIGN_IN,
    OP_IFRAME,
    PROMPT_NONE_IFRAME,
    RP_IFRAME,
    SET_SESSION_STATE_FROM_IFRAME,
    SILENT_SIGN_IN_STATE,
    STATE,
    Storage
} from "../constants";
import { AuthorizationInfo, Message, SessionManagementHelperInterface } from "../models";
import { SPAUtils } from "../utils";

export const SessionManagementHelper = (() => {
    let _clientID: string;
    let _checkSessionEndpoint: string;
    let _sessionState: () => Promise<string>;
    let _interval: number;
    let _redirectURL: string;
    let _authorizationEndpoint: string;
    let _sessionRefreshInterval: number;
    let _signOut: () => Promise<string>;
    let _sessionRefreshIntervalTimeout: number;
    let _checkSessionIntervalTimeout: number;
    let _storage: Storage;
    let _setSessionState: (sessionState: string) => void;
    let _isPKCEEnabled: boolean;

    const initialize = (
        clientID: string,
        checkSessionEndpoint: string,
        getSessionState: () => Promise<string>,
        interval: number,
        sessionRefreshInterval: number,
        redirectURL: string,
        authorizationEndpoint: string,
        isPKCEEnabled: boolean
    ): void => {
        _clientID = clientID;
        _checkSessionEndpoint = checkSessionEndpoint;
        _sessionState = getSessionState;
        _interval = interval;
        _redirectURL = redirectURL;
        _authorizationEndpoint = authorizationEndpoint;
        _sessionRefreshInterval = sessionRefreshInterval;
        _isPKCEEnabled = isPKCEEnabled;

        if (_interval > -1) {
            initiateCheckSession();
        }

        if (_sessionRefreshInterval > -1) {
            sessionRefreshInterval = setInterval(() => {
                sendPromptNoneRequest();
            }, _sessionRefreshInterval * 1000) as unknown as number;
        }
    };

    const initiateCheckSession = async (): Promise<void> => {
        if (!_checkSessionEndpoint || !_clientID || !_redirectURL) {
            return;
        }

        const OP_IFRAME = "opIFrame";

        async function checkSession(): Promise<void> {
            const sessionState = await _sessionState();
            if (Boolean(_clientID) && Boolean(sessionState)) {
                const message = `${ _clientID } ${ sessionState }`;
                const rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;
                const opIframe: HTMLIFrameElement
                    = rpIFrame?.contentDocument?.getElementById(OP_IFRAME) as HTMLIFrameElement;
                const win: Window | null = opIframe.contentWindow;
                win?.postMessage(message, _checkSessionEndpoint);
            }
        }

        const rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;
        const opIframe: HTMLIFrameElement
            = rpIFrame?.contentDocument?.getElementById(OP_IFRAME) as HTMLIFrameElement;
        opIframe.src = _checkSessionEndpoint + "?client_id=" + _clientID + "&redirect_uri=" + _redirectURL;
        await checkSession();

        _checkSessionIntervalTimeout =  setInterval(checkSession, _interval * 1000) as unknown as number;

        listenToResponseFromOPIFrame();
    };

    /**
     * Destroys session intervals.
     */
    const reset = (): void => {
        clearInterval(_checkSessionIntervalTimeout);
        clearInterval(_sessionRefreshIntervalTimeout);
    }

    const getRandomPKCEChallenge = (): string => {
        const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz-_";
        const stringLength = 43;
        let randomString = "";
        for (let i = 0; i < stringLength; i++) {
            const rnum = Math.floor(Math.random() * chars.length);
            randomString += chars.substring(rnum, rnum + 1);
        }
        return randomString;
    };

    const listenToResponseFromOPIFrame = (): void => {
        async function receiveMessage(e: MessageEvent) {
            const targetOrigin = _checkSessionEndpoint;

            if (!targetOrigin
                || targetOrigin?.indexOf(e.origin) < 0
                || e?.data?.type === SET_SESSION_STATE_FROM_IFRAME) {
                return;
            }

            if (e.data === "unchanged") {
                // [RP] session state has not changed
            } else if (e.data === "error") {
                window.location.href = await _signOut();
            } else if (e.data === "changed") {
                // [RP] session state has changed. Sending prompt=none request...
                sendPromptNoneRequest();
            }
        }

        window?.addEventListener("message", receiveMessage, false);
    };

    const sendPromptNoneRequest = () => {
        const rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;

        const promptNoneIFrame: HTMLIFrameElement = rpIFrame?.contentDocument?.getElementById(
            PROMPT_NONE_IFRAME
        ) as HTMLIFrameElement;

        if (SPAUtils.canSendPromptNoneRequest()) {
            SPAUtils.setPromptNoneRequestSent(true);

            const receiveMessageListener = (e: MessageEvent<Message<string>>) => {
                if (e?.data?.type === SET_SESSION_STATE_FROM_IFRAME) {
                    _setSessionState(e?.data?.data ?? "");
                    window?.removeEventListener("message", receiveMessageListener);
                }
            };

            if (_storage === Storage.BrowserMemory || _storage === Storage.WebWorker) {
                window?.addEventListener("message", receiveMessageListener);
            }

            const promptNoneURL = new URL(_authorizationEndpoint);
            promptNoneURL.searchParams.set("response_type", "code");
            promptNoneURL.searchParams.set("client_id", _clientID);
            promptNoneURL.searchParams.set("scope", "openid");
            promptNoneURL.searchParams.set("redirect_uri", _redirectURL);
            promptNoneURL.searchParams.set("state", STATE);
            promptNoneURL.searchParams.set("prompt", "none");

            if(_isPKCEEnabled){
                promptNoneURL.searchParams.set("code_challenge_method", "S256");
                promptNoneURL.searchParams.set("code_challenge", getRandomPKCEChallenge());
            }

            promptNoneIFrame.src = promptNoneURL.toString();
        }
    };

    /**
     * This contains the logic to process the response of a prompt none request.
     *
     * @param setSessionState The method that sets the session state.
     * on the output of the content of the redirect URL
     */
    const receivePromptNoneResponse = async (
        setSessionState?: (sessionState: string | null) => Promise<void>
    ): Promise<boolean> => {
        const state = new URL(window.location.href).searchParams.get("state");
        const sessionState = new URL(window.location.href).searchParams.get(SESSION_STATE);
        const parent = window.parent.parent;

        if (state !== null && (state === STATE || state === SILENT_SIGN_IN_STATE)) {
            // Prompt none response.
            const code = new URL(window.location.href).searchParams.get("code");

            if (code !== null && code.length !== 0) {
                if (state === SILENT_SIGN_IN_STATE) {
                    const message: Message<AuthorizationInfo> = {
                        data: {
                            code,
                            sessionState: sessionState ?? ""
                        },
                        type: CHECK_SESSION_SIGNED_IN
                    };

                    sessionStorage.setItem(INITIALIZED_SILENT_SIGN_IN, "false");
                    parent.postMessage(message, parent.origin);
                    SPAUtils.setPromptNoneRequestSent(false);

                    window.location.href = "about:blank";

                    await SPAUtils.waitTillPageRedirect();

                    return true;
                }

                const newSessionState = new URL(window.location.href).searchParams.get("session_state");

                if (_storage === Storage.LocalStorage || _storage === Storage.SessionStorage) {
                    setSessionState && await setSessionState(newSessionState);
                } else {
                    const message: Message<string> = {
                        data: newSessionState ?? "",
                        type: SET_SESSION_STATE_FROM_IFRAME
                    };

                    window?.parent?.parent?.postMessage(message);
                }

                SPAUtils.setPromptNoneRequestSent(false);

                window.location.href = "about:blank";

                await SPAUtils.waitTillPageRedirect();

                return true;
            } else {
                if (state === SILENT_SIGN_IN_STATE) {
                    const message: Message<null> = {
                        type: CHECK_SESSION_SIGNED_OUT
                    };

                    window.parent.parent.postMessage(message, parent.origin);
                    SPAUtils.setPromptNoneRequestSent(false);

                    window.location.href = "about:blank";

                    await SPAUtils.waitTillPageRedirect();

                    return true;
                }

                SPAUtils.setPromptNoneRequestSent(false);

                parent.location.href = await _signOut();
                window.location.href = "about:blank";

                await SPAUtils.waitTillPageRedirect();

                return true;
            }
        }

        return false;
    };

    return (
        signOut: () => Promise<string>,
        storage: Storage,
        setSessionState: (sessionState: string) => void
    ): SessionManagementHelperInterface => {
        let rpIFrame = document.createElement("iframe");
        rpIFrame.setAttribute("id", RP_IFRAME);
        rpIFrame.style.display = "none";

        rpIFrame.onload = () => {
            rpIFrame = document.getElementById(RP_IFRAME) as HTMLIFrameElement;

            const rpDoc = rpIFrame?.contentDocument;

            const opIFrame = rpDoc?.createElement("iframe");
            if (opIFrame) {
                opIFrame.setAttribute("id", OP_IFRAME);
                opIFrame.style.display = "none";
            }

            const promptNoneIFrame = rpDoc?.createElement("iframe");
            if (promptNoneIFrame) {
                promptNoneIFrame.setAttribute("id", PROMPT_NONE_IFRAME);
                promptNoneIFrame.style.display = "none";
            }

            opIFrame && rpIFrame?.contentDocument?.body?.appendChild(opIFrame);
            promptNoneIFrame && rpIFrame?.contentDocument?.body?.appendChild(promptNoneIFrame);
        }

        document?.body?.appendChild(rpIFrame);

        _signOut = signOut;

        _storage = storage;
        _setSessionState = setSessionState;

        return {
            initialize,
            receivePromptNoneResponse,
            reset
        };
    };
})();
