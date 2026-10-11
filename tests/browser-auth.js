(()=>{
  const uid=sessionStorage.getItem('synthetic-uid')||'test-owner-'+crypto.randomUUID();sessionStorage.setItem('synthetic-uid',uid);
  const user={uid,email:'synthetic@example.invalid',getIdToken:async()=> uid};
  const auth={setPersistence:async()=>{},onAuthStateChanged:fn=>{window.__testAuthChanged=fn;return fn(user);},signInWithPopup:async()=>{},signOut:async()=>{}};
  const factory=()=>auth;factory.Auth={Persistence:{LOCAL:'local'}};
  window.firebase={initializeApp:()=>{},auth:factory};
  window.firebase.auth.GoogleAuthProvider=class{setCustomParameters(){}};
})();
